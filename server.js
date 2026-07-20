require('dotenv').config();
const express = require('express');
const axios = require('axios');

const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN required'); process.exit(1); }

const PORT = process.env.PORT || 3000;
const INSTANTLY_KEY = process.env.INSTANTLY_API_KEY;
const INSTANTLY_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const CACHE_TTL_MS = 5 * 60 * 1000;
const CHANNELS = [
  { key: 'cold_call',           label: 'Cold Call',           cost: 4100 },
  { key: 'cold_email',          label: 'Cold Email',          cost: 1000 },
  { key: 'linkedin_automation', label: 'LinkedIn Automation', cost: 100 },
  { key: 'paid_ads',            label: 'Paid Ads',            cost: 1500 },
  { key: 'organic_inbound',     label: 'Organic Inbound',     cost: 0 },
  { key: 'user_generated',      label: 'User Generated',      cost: 0 },
  { key: 'referral',            label: 'Referral',            cost: 0 },
];
const PLAN_PRICING = { founder_59: 59, monthly_99: 99, annual_950: 79, free: 0, default: 59 };

const api = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (err.response?.status === 429 && i < retries - 1) { await sleep((i + 1) * 1500); continue; }
      throw err;
    }
  }
}

async function searchContacts(filters, properties) {
  const results = [];
  let after;
  while (true) {
    const body = { filterGroups: [{ filters }], properties, limit: 100 };
    if (after) body.after = after;
    const { data } = await withRetry(() => api.post('/crm/v3/objects/contacts/search', body));
    results.push(...data.results);
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
    await sleep(250);
  }
  return results;
}

async function fetchEngagementsByContact(objectType) {
  // Returns: { contactId: count }
  const byContact = {};
  let after;
  while (true) {
    const params = new URLSearchParams({ limit: '100', associations: 'contacts' });
    if (after) params.set('after', after);
    const { data } = await withRetry(() => api.get(`/crm/v3/objects/${objectType}?${params.toString()}`));
    for (const item of data.results) {
      const assoc = item.associations?.contacts?.results || [];
      for (const c of assoc) {
        byContact[c.id] = (byContact[c.id] || 0) + 1;
      }
    }
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
    await sleep(200);
  }
  return byContact;
}

// Instantly campaign data for the cold-email report. Two calls:
// analytics (denominators) + one batched lead lookup for cold-email paid
// customers (primary + secondary emails; leads can sit under either).
// Returns null when the key is missing or Instantly is unreachable, and the
// campaign section renders a notice instead of numbers.
async function fetchInstantly(paidCustomers) {
  if (!INSTANTLY_KEY) return null;
  const headers = { Authorization: `Bearer ${INSTANTLY_KEY}`, 'User-Agent': INSTANTLY_UA, 'Content-Type': 'application/json' };
  try {
    const { data: analytics } = await axios.get('https://api.instantly.ai/api/v2/campaigns/analytics', { headers, timeout: 20000 });
    const knownNames = new Set((analytics || []).map(a => a.campaign_name));
    const ceEmails = [];
    for (const c of paidCustomers) {
      const origin = c.properties.person_original_channel || c.properties.original_source_channel;
      if (origin !== 'cold_email') continue;
      if (knownNames.has(c.properties.sammy_utm_campaign)) continue; // stamped, no lookup needed
      const emails = [];
      if (c.properties.email) emails.push(c.properties.email.toLowerCase());
      for (const alt of (c.properties.hs_additional_emails || '').split(';')) {
        if (alt.trim()) emails.push(alt.trim().toLowerCase());
      }
      if (emails.length) ceEmails.push(emails);
    }
    // Batched lookup first (cheap), then per-customer retries: the contacts
    // filter drops matches nondeterministically at batch size, while
    // single-contact calls are stable. Without the retry pass, campaign
    // credit can wobble between refreshes.
    const leadCampaign = {};
    const flat = ceEmails.flat();
    for (let i = 0; i < flat.length; i += 90) {
      const { data } = await axios.post('https://api.instantly.ai/api/v2/leads/list',
        { contacts: flat.slice(i, i + 90), limit: 100 }, { headers, timeout: 20000 });
      for (const lead of data.items || []) {
        if (lead.email && lead.campaign) leadCampaign[lead.email.toLowerCase()] = lead.campaign;
      }
    }
    for (const custEmails of ceEmails) {
      if (custEmails.some(e => leadCampaign[e])) continue;
      const { data } = await axios.post('https://api.instantly.ai/api/v2/leads/list',
        { contacts: custEmails, limit: 10 }, { headers, timeout: 20000 });
      for (const lead of data.items || []) {
        if (lead.email && lead.campaign) leadCampaign[lead.email.toLowerCase()] = lead.campaign;
      }
      await sleep(150);
    }
    return { analytics, leadCampaign };
  } catch (err) {
    console.error('[instantly] fetch failed:', err.response?.status || err.message);
    return null;
  }
}

async function fetchData() {
  const paidCustomers = await searchContacts(
    [{ propertyName: 'user_status', operator: 'EQ', value: 'paid_customer' }],
    ['email', 'original_source_channel', 'person_original_channel', 'sammy_pricing_plan', 'sammy_promo_code', 'sammy_subscription_tier', 'sammy_utm_campaign', 'hs_additional_emails'],
  );

  const thirtyDaysAgoMs = Date.now() - 30 * 86400000;
  const recent = await searchContacts(
    [{ propertyName: 'createdate', operator: 'GTE', value: String(thirtyDaysAgoMs) }],
    ['email', 'original_source_channel', 'createdate'],
  );

  // Bulk-fetch all calls and meetings, tally per contact
  const [callsByContact, meetingsByContact] = await Promise.all([
    fetchEngagementsByContact('calls'),
    fetchEngagementsByContact('meetings'),
  ]);

  const instantly = await fetchInstantly(paidCustomers);

  return { paidCustomers, recent, callsByContact, meetingsByContact, instantly, fetchedAt: new Date().toISOString() };
}

// Closing-channel attribution: which channel actually closed the deal?
// Rule: 2+ calls OR 1+ meeting → cold_call (sales-led). Otherwise original_source_channel.
function determineClosingChannel(contact, callsByContact, meetingsByContact) {
  const calls = callsByContact[contact.id] || 0;
  const meetings = meetingsByContact[contact.id] || 0;
  if (calls >= 2 || meetings >= 1) return 'cold_call';
  return contact.properties.original_source_channel || '_unknown';
}

function customerMRR(c) {
  const plan = c.properties.sammy_pricing_plan;
  let price = PLAN_PRICING[plan] ?? PLAN_PRICING.default;
  // $10/mo promo discount lives in Stripe, fingerprinted by sammy_promo_code in HubSpot
  if (c.properties.sammy_promo_code) price = Math.max(price - 10, 0);
  return price;
}

function aggregate({ paidCustomers, recent, callsByContact, meetingsByContact, instantly }) {
  const init = {};
  const acq = {};
  for (const c of CHANNELS) {
    init[c.key] = { customers: 0, mrr: 0, new30d: 0, totalTouches: 0, originMix: {} };
    acq[c.key] = { customers: 0, mrr: 0, new30d: 0 };
  }
  init['_unknown'] = { customers: 0, mrr: 0, new30d: 0, totalTouches: 0, originMix: {} };
  acq['_unknown'] = { customers: 0, mrr: 0, new30d: 0 };
  const crosstab = {};
  const campaignPaid = {};

  for (const c of paidCustomers) {
    const price = customerMRR(c);

    // ACQUISITION view: which channel acquired the human.
    // person_original_channel counts multi-account humans once, credited to their first touch.
    const origin0 = c.properties.person_original_channel || c.properties.original_source_channel || '_unknown';
    const abucket = acq[origin0] || acq['_unknown'];
    abucket.customers += 1;
    abucket.mrr += price;

    // CLOSING view: sales effectiveness
    const closing = determineClosingChannel(c, callsByContact, meetingsByContact);
    const bucket = init[closing] || init['_unknown'];
    bucket.customers += 1;
    bucket.mrr += price;

    // Origination x closing crosstab
    crosstab[origin0] = crosstab[origin0] || {};
    crosstab[origin0][closing] = (crosstab[origin0][closing] || 0) + 1;

    // Cold-email campaign credit: HubSpot stamp first (written at creation
    // once the sammy-dashboard webhook update ships), live Instantly lead
    // match second, explicit "other" bucket for everything unverifiable.
    if (origin0 === 'cold_email') {
      let campKey = null;
      const stamp = c.properties.sammy_utm_campaign;
      if (stamp && instantly && (instantly.analytics || []).some(a => a.campaign_name === stamp)) campKey = 'name:' + stamp;
      if (!campKey && instantly) {
        const emails = [c.properties.email, ...(c.properties.hs_additional_emails || '').split(';')]
          .map(e => (e || '').trim().toLowerCase()).filter(Boolean);
        for (const e of emails) {
          if (instantly.leadCampaign[e]) { campKey = 'id:' + instantly.leadCampaign[e]; break; }
        }
      }
      const ck = campKey || 'other';
      campaignPaid[ck] = campaignPaid[ck] || { customers: 0, mrr: 0 };
      campaignPaid[ck].customers += 1;
      campaignPaid[ck].mrr += price;
    }

    const calls = callsByContact[c.id] || 0;
    const meetings = meetingsByContact[c.id] || 0;
    bucket.totalTouches += (calls + meetings);

    const origin = c.properties.original_source_channel || '_unknown';
    bucket.originMix[origin] = (bucket.originMix[origin] || 0) + 1;
  }

  // New (30d) stays by original source — these haven't converted yet so no closing channel exists
  for (const c of recent) {
    const ch = c.properties.original_source_channel || '_unknown';
    const bucket = init[ch] || init['_unknown'];
    bucket.new30d += 1;
    (acq[ch] || acq['_unknown']).new30d += 1;
  }

  const rows = CHANNELS.map(c => {
    const a = init[c.key];
    const avgTouches = a.customers > 0 ? +(a.totalTouches / a.customers).toFixed(1) : 0;
    return {
      key: c.key, label: c.label,
      customers: a.customers, mrr: a.mrr, new30d: a.new30d,
      avgTouches, originMix: a.originMix,
    };
  });
  rows.sort((a, b) => b.mrr - a.mrr || b.customers - a.customers);

  // Acquisition (budget) view: costs and ROI belong here, charged against the
  // channel that ACQUIRED the customer, not the channel that closed them.
  const acqRows = CHANNELS.map(c => {
    const a = acq[c.key];
    const roi = c.cost > 0 ? Math.round(((a.mrr - c.cost) / c.cost) * 100) : null;
    return { key: c.key, label: c.label, cost: c.cost, customers: a.customers, mrr: a.mrr, new30d: a.new30d, roi };
  });
  acqRows.sort((a, b) => b.mrr - a.mrr || b.customers - a.customers);
  const acqTotals = acqRows.reduce((t, r) => ({
    customers: t.customers + r.customers, mrr: t.mrr + r.mrr, new30d: t.new30d + r.new30d, cost: t.cost + r.cost,
  }), { customers: 0, mrr: 0, new30d: 0, cost: 0 });
  acqTotals.roi = acqTotals.cost > 0 ? Math.round(((acqTotals.mrr - acqTotals.cost) / acqTotals.cost) * 100) : null;
  const acqUnknown = acq['_unknown'];

  const totals = rows.reduce((t, r) => ({
    customers: t.customers + r.customers,
    mrr: t.mrr + r.mrr,
    new30d: t.new30d + r.new30d,
    totalTouches: t.totalTouches + (init[r.key].totalTouches || 0),
  }), { customers: 0, mrr: 0, new30d: 0, totalTouches: 0 });
  totals.avgTouches = totals.customers > 0 ? +(totals.totalTouches / totals.customers).toFixed(1) : 0;

  const unknown = init['_unknown'];

  // Campaign report rows: Instantly analytics denominators + verified paid credit.
  let campaignRows = null;
  let campaignOther = null;
  if (instantly) {
    campaignRows = (instantly.analytics || [])
      .filter(a => !(a.campaign_name || '').toLowerCase().startsWith('charm'))
      .map(a => {
        const byId = campaignPaid['id:' + a.campaign_id] || { customers: 0, mrr: 0 };
        const byName = campaignPaid['name:' + a.campaign_name] || { customers: 0, mrr: 0 };
        const paid = { customers: byId.customers + byName.customers, mrr: byId.mrr + byName.mrr };
        return {
          name: a.campaign_name, status: a.campaign_status,
          contacted: a.contacted_count || 0, replies: a.reply_count || 0,
          interested: a.total_opportunities || 0,
          customers: paid.customers, mrr: paid.mrr,
        };
      })
      .sort((a, b) => b.mrr - a.mrr || b.contacted - a.contacted);
    const creditedKeys = new Set();
    for (const a of instantly.analytics || []) { creditedKeys.add('id:' + a.campaign_id); creditedKeys.add('name:' + a.campaign_name); }
    campaignOther = { customers: 0, mrr: 0 };
    for (const [k, v] of Object.entries(campaignPaid)) {
      if (k === 'other' || !creditedKeys.has(k)) { campaignOther.customers += v.customers; campaignOther.mrr += v.mrr; }
    }
  }

  return { rows, totals, acqRows, acqTotals, acqUnknown, unknown, crosstab, campaignRows, campaignOther };
}

let cache = { data: null, time: 0, error: null, loading: null };

async function getData(force = false) {
  if (!force && cache.data && Date.now() - cache.time < CACHE_TTL_MS) return cache.data;
  if (cache.loading) return cache.loading;
  cache.loading = (async () => {
    try {
      const raw = await fetchData();
      const aggregated = aggregate(raw);
      cache.data = { ...aggregated, fetchedAt: raw.fetchedAt };
      cache.time = Date.now();
      cache.error = null;
      return cache.data;
    } catch (err) {
      cache.error = err.response?.data?.message || err.message;
      console.error('[fetch] failed:', cache.error);
      return cache.data;
    } finally {
      cache.loading = null;
    }
  })();
  return cache.loading;
}

function fmtMoney(n) { return '$' + Math.round(n).toLocaleString(); }
function fmtROI(roi) { if (roi === null) return '<span class="muted">N/A</span>'; const cls = roi >= 0 ? 'pos' : 'neg'; return `<span class="${cls}">${roi}%</span>`; }
function fmtAge(iso) {
  if (!iso) return '-';
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  return `${Math.round(sec / 3600)}h ago`;
}

function renderHTML(data, error) {
  if (!data) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Sammy Attribution</title>
      <style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#fafafa;color:#333}</style>
      </head><body><div><p>Loading data from HubSpot…</p>${error ? `<p style="color:#b00">Error: ${error}</p>` : ''}<script>setTimeout(()=>location.reload(),3000)</script></div></body></html>`;
  }
  const { rows, totals, acqRows, acqTotals, acqUnknown, unknown, crosstab, campaignRows, campaignOther, fetchedAt } = data;
  const fmtOriginMix = (mix) => {
    const entries = Object.entries(mix).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) return '<span class="muted">-</span>';
    return entries.map(([k, v]) => {
      const labelMap = { cold_email: 'Email', cold_call: 'Call', organic_inbound: 'Organic', user_generated: 'UGC', linkedin_automation: 'LinkedIn', paid_ads: 'Ads', referral: 'Ref', _unknown: '?' };
      return `<span class="mix-tag">${labelMap[k] || k} ${v}</span>`;
    }).join(' ');
  };
  const rowHtml = rows.map(r => `
    <tr class="${r.customers === 0 && r.new30d === 0 ? 'dim' : ''}">
      <td class="label">${r.label}</td>
      <td class="num">${r.customers}</td>
      <td class="num">${fmtMoney(r.mrr)}</td>
      <td class="num">${r.avgTouches > 0 ? r.avgTouches : '<span class="muted">-</span>'}</td>
      <td class="mix">${r.customers > 0 ? fmtOriginMix(r.originMix) : '<span class="muted">-</span>'}</td>
    </tr>`).join('');

  const acqRowHtml = acqRows.map(r => `
    <tr class="${r.customers === 0 && r.new30d === 0 ? 'dim' : ''}">
      <td class="label">${r.label}</td>
      <td class="num">${r.customers}</td>
      <td class="num">${fmtMoney(r.mrr)}</td>
      <td class="num">${r.new30d}</td>
      <td class="num">${r.cost > 0 ? fmtMoney(r.cost) : '<span class="muted">n/a</span>'}</td>
      <td class="num">${fmtROI(r.roi)}</td>
    </tr>`).join('');

  // Cold email by campaign
  const STATUS_LABEL = { 0: 'Draft', 1: 'Active', 2: 'Paused', 3: 'Ended', 4: 'Ended' };
  let campaignSection = '';
  if (campaignRows) {
    const totalCamp = campaignRows.reduce((t, r) => ({
      contacted: t.contacted + r.contacted, replies: t.replies + r.replies,
      interested: t.interested + r.interested, customers: t.customers + r.customers, mrr: t.mrr + r.mrr,
    }), { contacted: 0, replies: 0, interested: 0, customers: campaignOther.customers, mrr: campaignOther.mrr });
    const campHtml = campaignRows.map(r => `
    <tr class="${r.customers === 0 && r.status !== 1 ? 'dim' : ''}">
      <td class="label">${r.name} ${r.status === 1 ? '<span class="mix-tag">Active</span>' : `<span class="muted" style="font-size:11px">${STATUS_LABEL[r.status] || ''}</span>`}</td>
      <td class="num">${r.contacted.toLocaleString()}</td>
      <td class="num">${r.replies}</td>
      <td class="num">${r.interested}</td>
      <td class="num">${r.customers || '<span class="muted">0</span>'}</td>
      <td class="num">${r.mrr ? fmtMoney(r.mrr) : '<span class="muted">-</span>'}</td>
    </tr>`).join('');
    campaignSection = `
  <h2 class="section-title">Cold email by campaign</h2>
  <p class="section-sub">Instantly campaign performance joined to verified paying customers. A customer is credited to a campaign only when the campaign stamp or a live Instantly lead match confirms it; everything unverifiable stays in the last row rather than being guessed.</p>
  <div class="card">
    <table>
      <thead>
        <tr><th>Campaign</th><th>Contacted</th><th>Replies</th><th>Interested</th><th>Paying Customers</th><th>MRR</th></tr>
      </thead>
      <tbody>${campHtml}
    <tr>
      <td class="label muted">Other cold email (Clay, EmailBison era, removed Instantly leads)</td>
      <td class="num"><span class="muted">n/a</span></td>
      <td class="num"><span class="muted">n/a</span></td>
      <td class="num"><span class="muted">n/a</span></td>
      <td class="num">${campaignOther.customers}</td>
      <td class="num">${fmtMoney(campaignOther.mrr)}</td>
    </tr></tbody>
      <tfoot>
        <tr>
          <td>Total cold email</td>
          <td class="num">${totalCamp.contacted.toLocaleString()}</td>
          <td class="num">${totalCamp.replies}</td>
          <td class="num">${totalCamp.interested}</td>
          <td class="num">${totalCamp.customers}</td>
          <td class="num">${fmtMoney(totalCamp.mrr)}</td>
        </tr>
      </tfoot>
    </table>
  </div>`;
  } else {
    campaignSection = `
  <h2 class="section-title">Cold email by campaign</h2>
  <p class="section-sub">Instantly data unavailable (missing INSTANTLY_API_KEY or Instantly unreachable). No numbers are shown rather than stale or partial ones.</p>`;
  }

  // Origination x closing crosstab
  const closingKeys = CHANNELS.filter(c => rows.some(r => r.key === c.key && r.customers > 0)).map(c => c.key);
  const originKeys = CHANNELS.filter(c => (crosstab[c.key] && Object.keys(crosstab[c.key]).length)).map(c => c.key);
  const chLabel = k => (CHANNELS.find(c => c.key === k) || { label: k }).label;
  const xtabHtml = originKeys.map(o => {
    const rowTotal = Object.values(crosstab[o]).reduce((a, b) => a + b, 0);
    return `
    <tr>
      <td class="label">${chLabel(o)}</td>
      ${closingKeys.map(k => `<td class="num">${crosstab[o][k] || '<span class="muted">0</span>'}</td>`).join('')}
      <td class="num"><strong>${rowTotal}</strong></td>
    </tr>`;
  }).join('');
  const xtabColTotals = closingKeys.map(k => originKeys.reduce((t, o) => t + (crosstab[o][k] || 0), 0));
  const crosstabSection = `
  <h2 class="section-title">Origination x closing</h2>
  <p class="section-sub">Rows are where customers came from, columns are how they were closed. Read a row to see how much of a channel's pipeline the sales team converts versus self-serve.</p>
  <div class="card">
    <table>
      <thead>
        <tr><th>Originated → Closed by</th>${closingKeys.map(k => `<th>${chLabel(k)}</th>`).join('')}<th>Total</th></tr>
      </thead>
      <tbody>${xtabHtml}</tbody>
      <tfoot>
        <tr><td>Total</td>${xtabColTotals.map(t => `<td class="num">${t}</td>`).join('')}<td class="num">${xtabColTotals.reduce((a, b) => a + b, 0)}</td></tr>
      </tfoot>
    </table>
  </div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sammy Attribution</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fafafa;color:#1a1a1a;padding:32px 16px;min-height:100vh}
  .container{max-width:1080px;margin:0 auto}
  .mix-tag{display:inline-block;background:#eef;color:#446;padding:1px 6px;border-radius:3px;font-size:11px;font-variant-numeric:tabular-nums;margin-right:2px}
  .mix{font-size:12px;line-height:1.6}
  h1{font-size:24px;font-weight:700;margin-bottom:4px;letter-spacing:-0.5px}
  .meta{color:#888;font-size:13px;margin-bottom:24px}
  .meta .refresh{color:#0066cc;cursor:pointer;text-decoration:none}
  .meta .refresh:hover{text-decoration:underline}
  .section-title{font-size:16px;font-weight:600;margin:26px 0 2px;letter-spacing:-0.2px}
  .section-sub{color:#888;font-size:12.5px;margin-bottom:10px;line-height:1.5}
  .card{background:#fff;border:1px solid #eee;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.03)}
  table{width:100%;border-collapse:collapse;font-size:14px}
  thead th{text-align:right;padding:14px 16px;font-weight:600;color:#666;background:#fafafa;border-bottom:1px solid #eee;font-size:12px;text-transform:uppercase;letter-spacing:0.5px}
  thead th:first-child{text-align:left}
  tbody td{padding:14px 16px;border-bottom:1px solid #f4f4f4}
  tbody tr:last-child td{border-bottom:none}
  .label{font-weight:500}
  .num{text-align:right;font-variant-numeric:tabular-nums}
  .dim{opacity:0.45}
  tfoot td{padding:14px 16px;font-weight:600;background:#fafafa;border-top:2px solid #eee;font-size:14px}
  tfoot .num{font-variant-numeric:tabular-nums}
  .pos{color:#0a8a3a}
  .neg{color:#c0392b}
  .muted{color:#aaa}
  .footnote{color:#999;font-size:12px;margin-top:16px;line-height:1.6}
  .footnote code{background:#f0f0f0;padding:2px 6px;border-radius:3px;font-size:11px}
  ${unknown.customers > 0 || unknown.new30d > 0 ? '.unknown-warning{margin-top:12px;padding:10px 14px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;font-size:13px;color:#666}' : ''}
  @media (max-width:600px){
    body{padding:16px 12px}
    h1{font-size:20px}
    thead th{padding:10px 8px;font-size:10px}
    tbody td{padding:10px 8px;font-size:13px}
    tfoot td{padding:10px 8px;font-size:13px}
  }
</style>
</head>
<body>
<div class="container">
  <h1>Sammy Attribution</h1>
  <p class="meta">Updated ${fmtAge(fetchedAt)} &middot; <a class="refresh" href="/?force=1">refresh now</a></p>

  <h2 class="section-title">Acquisition (budget view)</h2>
  <p class="section-sub">Which channel brought each paying customer in. One row per human: linked accounts count once, credited to the first channel that reached them. Spend decisions read from this table.</p>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Channel</th>
          <th>Customers</th>
          <th>MRR</th>
          <th>New (30d)</th>
          <th>Cost/mo</th>
          <th>ROI</th>
        </tr>
      </thead>
      <tbody>${acqRowHtml}</tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td class="num">${acqTotals.customers}</td>
          <td class="num">${fmtMoney(acqTotals.mrr)}</td>
          <td class="num">${acqTotals.new30d}</td>
          <td class="num">${fmtMoney(acqTotals.cost)}</td>
          <td class="num">${fmtROI(acqTotals.roi)}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <h2 class="section-title">Sales effectiveness (closing view)</h2>
  <p class="section-sub">How customers were closed once acquired. 2+ calls or 1+ meeting counts as a sales-led close. This view measures the sales motion, not channel spend, so ROI does not apply here.</p>
  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Closing Channel</th>
          <th>Customers</th>
          <th>MRR</th>
          <th>Avg Touches</th>
          <th>Originated From</th>
        </tr>
      </thead>
      <tbody>${rowHtml}</tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td class="num">${totals.customers}</td>
          <td class="num">${fmtMoney(totals.mrr)}</td>
          <td class="num">${totals.avgTouches}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  </div>
  ${campaignSection}
  ${crosstabSection}
  ${unknown.customers > 0 || unknown.new30d > 0 ? `<div class="unknown-warning"><strong>${unknown.customers}</strong> paying customer(s) and <strong>${unknown.new30d}</strong> recent contact(s) have no <code>original_source_channel</code> set yet. The hourly classifier will pick them up on its next run.</div>` : ''}
  <p class="footnote">
    <strong>Acquisition</strong> reads <code>person_original_channel</code> (person level, set by the governed classifier) with <code>original_source_channel</code> as fallback. MRR uses <code>sammy_pricing_plan</code> minus the $10 promo discount where <code>sammy_promo_code</code> is set.
    <strong>ROI</strong> = (MRR minus monthly cost) / cost, charged to the acquiring channel. Paid ads cost is an estimate pending actual Meta spend numbers; cold call cost covers the whole sales team, which also closes deals sourced by other channels, so treat its ROI as conservative.
    <strong>Closing Channel</strong> = where the deal was actually closed. Rule: 2+ calls or 1+ meeting on a paid customer means sales-led close (cold_call); otherwise the original lead source wins.
    <strong>Avg Touches</strong> = average calls + meetings per paid customer in that bucket.
    <strong>Originated From</strong> = of the customers closed here, where they originally entered HubSpot (Email = cold email, Organic = inbound form, UGC = manual/user-generated).
    <strong>Cold email by campaign</strong>: denominators from Instantly analytics; paying customers matched by campaign stamp or live lead lookup (primary and secondary emails). Customers acquired before Instantly or whose leads were removed cannot be re-matched and stay in the "Other" row; campaign stamping at contact creation (sammy-dashboard webhook update) grows verified coverage over time.
    Source: HubSpot, cached 5 min. <a class="refresh" href="/?force=1">Force refresh</a>.
  </p>
</div>
</body>
</html>`;
}

const app = express();
app.get('/health', (req, res) => res.send('ok'));
app.get('/api/data', async (req, res) => {
  const data = await getData(req.query.force === '1');
  if (!data) return res.status(503).json({ status: 'loading', error: cache.error });
  res.json(data);
});
app.get('/', async (req, res) => {
  const data = await getData(req.query.force === '1');
  res.type('html').send(renderHTML(data, cache.error));
});

app.listen(PORT, () => {
  console.log(`Sammy Attribution on :${PORT}`);
  getData(true);
});
