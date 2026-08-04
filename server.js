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
    ['email', 'original_source_channel', 'person_original_channel', 'sammy_pricing_plan', 'sammy_promo_code', 'sammy_subscription_tier', 'sammy_utm_campaign', 'cold_email_reply_campaign', 'hs_additional_emails'],
  );

  const thirtyDaysAgoMs = Date.now() - 30 * 86400000;
  const recent = await searchContacts(
    [{ propertyName: 'createdate', operator: 'GTE', value: String(thirtyDaysAgoMs) }],
    ['email', 'original_source_channel', 'createdate', 'firstname', 'phone', 'hs_calculated_phone_number', 'hs_object_source_label', 'hs_object_source_detail_1'],
  );

  // Bulk-fetch all calls and meetings, tally per contact
  const [callsByContact, meetingsByContact] = await Promise.all([
    fetchEngagementsByContact('calls'),
    fetchEngagementsByContact('meetings'),
  ]);

  // weekly activity metrics for the at-a-glance strip
  const weekAgoMs = String(Date.now() - 7 * 86400000);
  const weekly = { calls: 0, meetings: 0, won: 0, wonAmount: 0 };
  try {
    const { data: cw } = await withRetry(() => api.post('/crm/v3/objects/calls/search',
      { filterGroups: [{ filters: [{ propertyName: 'hs_timestamp', operator: 'GTE', value: weekAgoMs }] }], limit: 1 }));
    weekly.calls = cw.total;
    const { data: mw } = await withRetry(() => api.post('/crm/v3/objects/meetings/search',
      { filterGroups: [{ filters: [{ propertyName: 'hs_timestamp', operator: 'GTE', value: weekAgoMs }] }], limit: 1 }));
    weekly.meetings = mw.total;
    const { data: ww } = await withRetry(() => api.post('/crm/v3/objects/deals/search',
      { filterGroups: [{ filters: [{ propertyName: 'hs_v2_date_entered_decisionmakerboughtin', operator: 'GTE', value: weekAgoMs }] }],
        properties: ['amount'], limit: 100 }));
    weekly.won = ww.total;
    weekly.wonAmount = ww.results.reduce((t, r) => t + (parseFloat(r.properties.amount) || 0), 0);
  } catch (err) {
    console.error('[weekly] metrics failed:', err.response?.status || err.message);
  }

  const instantly = await fetchInstantly(paidCustomers);

  // Leak-junk cohort: ownerless members of HubSpot list 835 (cold-email webhook
  // leak, no owner, no activity). Excluded from funnel denominators per Chris,
  // with a visible callout. Self-corrects if the contacts are ever deleted.
  let junk = null;
  try {
    const jids = [];
    let jafter;
    while (true) {
      const { data } = await withRetry(() => api.get(`/crm/v3/lists/835/memberships?limit=250${jafter ? `&after=${jafter}` : ''}`));
      for (const r of data.results || []) jids.push(String(typeof r === 'object' ? r.recordId : r));
      if (!data.paging?.next?.after) break;
      jafter = data.paging.next.after;
    }
    let ownerless = 0;
    for (let i = 0; i < jids.length; i += 100) {
      const { data } = await withRetry(() => api.post('/crm/v3/objects/contacts/batch/read',
        { inputs: jids.slice(i, i + 100).map(id => ({ id })), properties: ['hubspot_owner_id'] }));
      ownerless += (data.results || []).filter(r => !r.properties.hubspot_owner_id).length;
    }
    junk = { listSize: jids.length, ownerless };
  } catch (err) {
    console.error('[junk] list 835 fetch failed:', err.response?.status || err.message);
  }

  // Funnel counts: per-channel contact totals (cheap total-only searches) +
  // one paged pull of everyone with a user_status, bucketed by channel.
  const funnel = {};
  for (const ch of CHANNELS) {
    const { data } = await withRetry(() => api.post('/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters: [{ propertyName: 'original_source_channel', operator: 'EQ', value: ch.key }] }],
      limit: 1,
    }));
    funnel[ch.key] = { contacts: data.total, signups: 0, trials: 0, paid: 0, churned: 0 };
    await sleep(120);
  }
  const statusContacts = await searchContacts(
    [{ propertyName: 'user_status', operator: 'HAS_PROPERTY' }],
    ['original_source_channel', 'user_status'],
  );
  for (const c of statusContacts) {
    const b = funnel[c.properties.original_source_channel];
    if (!b) continue;
    b.signups += 1;
    const st = c.properties.user_status;
    if (st === 'active_trial' || st === 'trial_expired') b.trials += 1;
    else if (st === 'paid_customer') b.paid += 1;
    else if (st === 'churned') b.churned += 1;
  }

  return { paidCustomers, recent, callsByContact, meetingsByContact, instantly, funnel, junk, weekly, fetchedAt: new Date().toISOString() };
}

// Closing-channel attribution: which channel actually closed the deal?
// Rule: 2+ calls OR 1+ meeting → cold_call (sales-led). Otherwise original_source_channel.
function determineClosingChannel(contact, callsByContact, meetingsByContact) {
  const calls = callsByContact[contact.id] || 0;
  const meetings = meetingsByContact[contact.id] || 0;
  if (calls >= 2 || meetings >= 1) return 'cold_call';
  return contact.properties.original_source_channel || '_unknown';
}

// Recurring monthly discounts by promo code. One-time coupons (e.g. 50% off
// first month) do NOT reduce ongoing MRR and must not appear here.
const PROMO_MONTHLY_DISCOUNT = {
  qRlQX1PO: 10,               // $10/mo off, recurring
  // oJiHwI0k / FIRSTMO50: 50% off first month only - no MRR impact
};

function customerMRR(c) {
  const plan = c.properties.sammy_pricing_plan;
  let price = PLAN_PRICING[plan] ?? PLAN_PRICING.default;
  const discount = PROMO_MONTHLY_DISCOUNT[c.properties.sammy_promo_code];
  if (discount) price = Math.max(price - discount, 0);
  return price;
}

function aggregate({ paidCustomers, recent, callsByContact, meetingsByContact, instantly, funnel, junk, weekly }) {
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
      // Clay writes the replied-to campaign name (covers Instantly AND legacy
      // EmailBison-era campaigns); cross-validated against stamps and lead matches
      if (!campKey && c.properties.cold_email_reply_campaign) campKey = 'name:' + c.properties.cold_email_reply_campaign;
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
      if (k === 'other') { campaignOther.customers += v.customers; campaignOther.mrr += v.mrr; continue; }
      if (creditedKeys.has(k)) continue;
      if (k.startsWith('name:')) {
        // Named campaign with no Instantly analytics = legacy platform era.
        campaignRows.push({ name: k.slice(5), status: null, contacted: null, replies: null, interested: null, customers: v.customers, mrr: v.mrr });
      } else {
        campaignOther.customers += v.customers; campaignOther.mrr += v.mrr;
      }
    }
    campaignRows.sort((a, b) => b.mrr - a.mrr || (b.contacted || 0) - (a.contacted || 0));
  }

  // weekly new-lead mix from the recent cohort
  const wkAgo = Date.now() - 7 * 86400000;
  const newLeads7 = { total: 0, byChannel: {} };
  for (const c of recent) {
    if (new Date(c.properties.createdate).getTime() < wkAgo) continue;
    newLeads7.total += 1;
    const ch = c.properties.original_source_channel || 'unknown';
    newLeads7.byChannel[ch] = (newLeads7.byChannel[ch] || 0) + 1;
  }

  // Data quality: recent contacts arriving without a dialable phone, by source
  const sevenDaysAgo = Date.now() - 7 * 86400000;
  const phonelessSrc = {};
  let phoneless7 = 0, phoneless30 = 0;
  for (const c of recent) {
    const p = c.properties;
    if (p.hs_calculated_phone_number || p.phone) continue;
    const key = p.hs_object_source_detail_1 || p.hs_object_source_label || 'unknown source';
    const e = phonelessSrc[key] = phonelessSrc[key] || { d7: 0, d30: 0, nameless: 0 };
    e.d30 += 1; phoneless30 += 1;
    if (!p.firstname) e.nameless += 1;
    if (new Date(p.createdate).getTime() >= sevenDaysAgo) { e.d7 += 1; phoneless7 += 1; }
  }
  const phonelessRows = Object.entries(phonelessSrc)
    .map(([source, e]) => ({ source, ...e }))
    .sort((a, b) => b.d30 - a.d30);

  const pct = (n, d) => d > 0 ? Math.round((n / d) * 1000) / 10 : null;
  const junkExcluded = junk ? junk.ownerless : 0;
  const funnelRows = CHANNELS
    .map(c => {
      const f = { ...(funnel[c.key] || { contacts: 0, signups: 0, trials: 0, paid: 0, churned: 0 }) };
      if (c.key === 'cold_email' && junkExcluded) f.contacts = Math.max(f.contacts - junkExcluded, 0);
      return {
        key: c.key, label: c.label, ...f,
        signupRate: pct(f.signups, f.contacts),
        contactToPaid: pct(f.paid, f.contacts),
        signupToPaid: pct(f.paid, f.signups),
        churnRate: pct(f.churned, f.paid + f.churned),
      };
    })
    .filter(r => r.contacts > 0)
    .sort((a, b) => b.paid - a.paid || b.contacts - a.contacts);

  return { rows, totals, acqRows, acqTotals, acqUnknown, unknown, crosstab, campaignRows, campaignOther, funnelRows, junkExcluded, phonelessRows, phoneless7, phoneless30, recent30: recent.length, weekly, newLeads7 };
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
  const { rows, totals, acqRows, acqTotals, acqUnknown, unknown, crosstab, campaignRows, campaignOther, funnelRows, junkExcluded, phonelessRows, phoneless7, phoneless30, recent30, weekly, newLeads7, fetchedAt } = data;
  const chShort = { cold_email: 'email', organic_inbound: 'organic', cold_call: 'call', paid_ads: 'ads', user_generated: 'ugc', linkedin_automation: 'li', referral: 'ref', unknown: '?' };
  const leadMix = Object.entries(newLeads7.byChannel).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => v + ' ' + (chShort[k] || k)).join(' / ');
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
      contacted: t.contacted + (r.contacted || 0), replies: t.replies + (r.replies || 0),
      interested: t.interested + (r.interested || 0), customers: t.customers + r.customers, mrr: t.mrr + r.mrr,
    }), { contacted: 0, replies: 0, interested: 0, customers: campaignOther.customers, mrr: campaignOther.mrr });
    const na = '<span class="muted">n/a</span>';
    const campHtml = campaignRows.map(r => `
    <tr class="${r.customers === 0 && r.status !== 1 ? 'dim' : ''}">
      <td class="label">${r.name} ${r.status === 1 ? '<span class="mix-tag">Active</span>' : r.status === null ? '<span class="muted" style="font-size:11px">Legacy</span>' : `<span class="muted" style="font-size:11px">${STATUS_LABEL[r.status] || ''}</span>`}</td>
      <td class="num">${r.contacted === null ? na : r.contacted.toLocaleString()}</td>
      <td class="num">${r.replies === null ? na : r.replies}</td>
      <td class="num">${r.interested === null ? na : r.interested}</td>
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
      <td class="label muted">Other cold email (no campaign signal on record)</td>
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
  <h2 class="section-title">Data quality: contacts arriving without phone numbers</h2>
  <p class="section-sub">New contacts whose creation source did not supply a dialable phone. These get no call task until a number lands, so this table shows which pipes need tightening. ${phoneless30} of the last 30 days' ${recent30} new contacts arrived phoneless (${phoneless7} in the last 7 days).</p>
  <div class="card">
    <table>
      <thead>
        <tr><th>Creation Source</th><th>Last 7 Days</th><th>Last 30 Days</th><th>Also Missing Name (30d)</th></tr>
      </thead>
      <tbody>${phonelessRows.map(r => `
    <tr class="${r.d7 === 0 ? 'dim' : ''}">
      <td class="label">${r.source}</td>
      <td class="num">${r.d7 || '<span class="muted">0</span>'}</td>
      <td class="num">${r.d30}</td>
      <td class="num">${r.nameless || '<span class="muted">0</span>'}</td>
    </tr>`).join('') || '<tr><td class="label muted" colspan="4">No phoneless contacts in the last 30 days</td></tr>'}</tbody>
      <tfoot>
        <tr><td>Total</td><td class="num">${phoneless7}</td><td class="num">${phoneless30}</td><td class="num">${phonelessRows.reduce((t, r) => t + r.nameless, 0)}</td></tr>
      </tfoot>
    </table>
  </div>

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
  .wk{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0 6px}
  .wk .tile{background:#fff;border:1px solid #eee;border-radius:10px;padding:12px 14px;box-shadow:0 1px 3px rgba(0,0,0,0.03)}
  .wk .big{font-size:22px;font-weight:700;letter-spacing:-0.5px}
  .wk .lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px}
  .wk .sub{font-size:11px;color:#aaa;margin-top:4px}
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

  <h2 class="section-title">This week at a glance</h2>
  <p class="section-sub">Rolling 7 days, live from HubSpot.</p>
  <div class="wk">
    <div class="tile"><div class="big">${weekly.won}</div><div class="lbl">Deals Won</div><div class="sub">${fmtMoney(weekly.wonAmount)}/mo added</div></div>
    <div class="tile"><div class="big">${newLeads7.total}</div><div class="lbl">New Leads</div><div class="sub">${leadMix || 'none'}</div></div>
    <div class="tile"><div class="big">${weekly.calls.toLocaleString()}</div><div class="lbl">Calls Made</div><div class="sub">team total</div></div>
    <div class="tile"><div class="big">${weekly.meetings}</div><div class="lbl">Meetings</div><div class="sub">booked/held</div></div>
    <div class="tile"><div class="big">${phoneless7}</div><div class="lbl">Phoneless Arrivals</div><div class="sub">see data quality</div></div>
    <div class="tile"><div class="big">${acqTotals.customers}</div><div class="lbl">Customers Now</div><div class="sub">${fmtMoney(acqTotals.mrr)} MRR</div></div>
  </div>

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

  <h2 class="section-title">Funnel and conversion by channel</h2>
  <p class="section-sub">Contact counts by source channel, through signup to paid. Signup to Paid shows how well each channel's leads close once they enter the product; Churn is the share of ever-paying customers that have left.</p>
  <div class="card">
    <table>
      <thead>
        <tr><th>Channel</th><th>Contacts</th><th>Signed Up</th><th>Signup %</th><th>In Trial</th><th>Paying</th><th>Contact&rarr;Paid</th><th>Signup&rarr;Paid</th><th>Churned</th><th>Churn %</th></tr>
      </thead>
      <tbody>${funnelRows.map(r => `
    <tr>
      <td class="label">${r.label}</td>
      <td class="num">${r.contacts.toLocaleString()}</td>
      <td class="num">${r.signups}</td>
      <td class="num">${r.signupRate === null ? '<span class="muted">-</span>' : r.signupRate + '%'}</td>
      <td class="num">${r.trials}</td>
      <td class="num">${r.paid}</td>
      <td class="num">${r.contactToPaid === null ? '<span class="muted">-</span>' : r.contactToPaid + '%'}</td>
      <td class="num">${r.signupToPaid === null ? '<span class="muted">-</span>' : r.signupToPaid + '%'}</td>
      <td class="num">${r.churned}</td>
      <td class="num">${r.churnRate === null ? '<span class="muted">-</span>' : `<span class="${r.churnRate >= 30 ? 'neg' : ''}">${r.churnRate}%</span>`}</td>
    </tr>`).join('')}</tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td class="num">${funnelRows.reduce((t, r) => t + r.contacts, 0).toLocaleString()}</td>
          <td class="num">${funnelRows.reduce((t, r) => t + r.signups, 0)}</td>
          <td></td>
          <td class="num">${funnelRows.reduce((t, r) => t + r.trials, 0)}</td>
          <td class="num">${funnelRows.reduce((t, r) => t + r.paid, 0)}</td>
          <td></td><td></td>
          <td class="num">${funnelRows.reduce((t, r) => t + r.churned, 0)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  </div>

  ${junkExcluded ? `<div class="unknown-warning" style="margin-top:12px;padding:10px 14px;background:#fff8e1;border:1px solid #ffe082;border-radius:6px;font-size:13px;color:#666">Cold Email contact counts above exclude <strong>${junkExcluded}</strong> known junk contacts from the reply-webhook leak (no owner, no activity, held in the deletion review list). They remain in HubSpot and in the raw acquisition counts; only the funnel rates ignore them.</div>` : ''}

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
    <strong>Funnel</strong> counts are contact-level by source channel (person-level linking makes the acquisition table differ by a customer or so). In Trial is a current snapshot, not everyone who ever trialed, because the app overwrites trial status on conversion or expiry. Churn % = churned / (paying + churned).
    <strong>Originated From</strong> = of the customers closed here, where they originally entered HubSpot (Email = cold email, Organic = inbound form, UGC = manual/user-generated).
    <strong>Cold email by campaign</strong>: denominators from Instantly analytics; paying customers matched by campaign stamp, the Clay-written reply campaign field, or live lead lookup (primary and secondary emails). Legacy rows are pre-Instantly campaigns recovered from reply data; their send volumes are not available. Customers acquired before Instantly or whose leads were removed cannot be re-matched and stay in the "Other" row; campaign stamping at contact creation (sammy-dashboard webhook update) grows verified coverage over time.
    Source: HubSpot, cached 5 min. <a class="refresh" href="/?force=1">Force refresh</a>.
  </p>
</div>
</body>
</html>`;
}


// ---------- Lucas scorecard (/lucas) ----------
const LUCAS_ID = '86929887';

function melBounds() {
  // Melbourne day/week boundaries in epoch ms, DST-safe
  const now = new Date();
  const melStr = now.toLocaleString('sv', { timeZone: 'Australia/Melbourne' }); // YYYY-MM-DD HH:mm:ss
  const ymd = melStr.slice(0, 10);
  const offsetMs = Date.parse(melStr.replace(' ', 'T') + 'Z') - now.getTime();
  const dayStart = Date.parse(ymd + 'T00:00:00Z') - offsetMs;
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay() || 7; // Mon=1..Sun=7
  const weekStart = dayStart - (dow - 1) * 86400000;
  return { dayStart, weekStart };
}

async function searchAll(object, filters, properties) {
  const out = [];
  let after;
  while (true) {
    const body = { filterGroups: [{ filters }], properties, limit: 100 };
    if (after) body.after = after;
    const { data } = await withRetry(() => api.post(`/crm/v3/objects/${object}/search`, body));
    out.push(...data.results);
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
    await sleep(250);
  }
  return out;
}

async function fetchLucasData() {
  const { dayStart, weekStart } = melBounds();
  const wk = String(weekStart);

  const calls = await searchAll('calls', [
    { propertyName: 'hubspot_owner_id', operator: 'EQ', value: LUCAS_ID },
    { propertyName: 'hs_timestamp', operator: 'GTE', value: wk },
    { propertyName: 'hs_call_direction', operator: 'EQ', value: 'OUTBOUND' },
  ], ['hs_timestamp', 'hs_call_to_number']);

  const meetingProps = ['hs_meeting_outcome', 'hs_meeting_source', 'hs_createdate', 'hs_timestamp', 'hs_meeting_title'];
  const booked = await searchAll('meetings', [
    { propertyName: 'hubspot_owner_id', operator: 'EQ', value: LUCAS_ID },
    { propertyName: 'hs_createdate', operator: 'GTE', value: wk },
  ], meetingProps);
  const happening = await searchAll('meetings', [
    { propertyName: 'hubspot_owner_id', operator: 'EQ', value: LUCAS_ID },
    { propertyName: 'hs_timestamp', operator: 'GTE', value: wk },
  ], meetingProps);
  const meetings = {};
  for (const m of [...booked, ...happening]) meetings[m.id] = m;

  // resolve contacts for calls and meetings so drill-downs show names
  async function assocMap(fromType, ids) {
    const map = {};
    for (let i = 0; i < ids.length; i += 100) {
      const { data } = await withRetry(() => api.post(`/crm/v4/associations/${fromType}/contacts/batch/read`,
        { inputs: ids.slice(i, i + 100).map(id => ({ id })) }));
      for (const r of data.results || []) {
        const to = (r.to || [])[0];
        if (to) map[String(r.from.id)] = String(to.toObjectId);
      }
      await sleep(150);
    }
    return map;
  }
  const callContact = await assocMap('calls', calls.map(c => c.id));
  const mtgContact = await assocMap('meetings', Object.keys(meetings));

  const cids = [...new Set([...Object.values(callContact), ...Object.values(mtgContact)])];
  const contacts = {};
  for (let i = 0; i < cids.length; i += 100) {
    const { data } = await withRetry(() => api.post('/crm/v3/objects/contacts/batch/read',
      { inputs: cids.slice(i, i + 100).map(id => ({ id })), properties: ['firstname', 'lastname', 'email', 'user_status', 'sammy_trial_start_date'] }));
    for (const r of data.results || []) contacts[r.id] = r.properties;
    await sleep(150);
  }

  // sales made = deals entering the won stage (moved automatically when a
  // contact becomes a paying customer)
  const wonDeals = await searchAll('deals', [
    { propertyName: 'hs_v2_date_entered_decisionmakerboughtin', operator: 'GTE', value: wk },
  ], ['dealname', 'amount', 'hs_v2_date_entered_decisionmakerboughtin']);
  const dealContact = await assocMap('deals', wonDeals.map(d => d.id));
  const dcids = [...new Set(Object.values(dealContact))].filter(id => !contacts[id]);
  for (let i = 0; i < dcids.length; i += 100) {
    const { data } = await withRetry(() => api.post('/crm/v3/objects/contacts/batch/read',
      { inputs: dcids.slice(i, i + 100).map(id => ({ id })), properties: ['firstname', 'lastname', 'email', 'user_status', 'sammy_pricing_plan'] }));
    for (const r of data.results || []) contacts[r.id] = r.properties;
    await sleep(150);
  }

  return { calls, meetings: Object.values(meetings), callContact, mtgContact, contacts, wonDeals, dealContact,
           dayStart, weekStart, fetchedAt: new Date().toISOString() };
}

function lucasStats(d) {
  const { calls, meetings, callContact, mtgContact, contacts, wonDeals, dealContact, dayStart, weekStart } = d;
  const inDay = ts => Number(new Date(ts)) >= dayStart;
  const cname = id => {
    const p = contacts[id];
    if (!p) return null;
    return [p.firstname, p.lastname].filter(Boolean).join(' ') || p.email || `contact ${id}`;
  };
  const fmtT = ts => new Date(ts).toLocaleString('en-AU', { timeZone: 'Australia/Melbourne', weekday: 'short', hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'short' });

  // dials grouped by number
  const byNum = {};
  for (const c of calls) {
    const n = c.properties.hs_call_to_number || '(no number)';
    const e = byNum[n] = byNum[n] || { number: n, count: 0, today: 0, cid: null, last: 0 };
    e.count += 1;
    if (inDay(c.properties.hs_timestamp)) e.today += 1;
    e.cid = e.cid || callContact[c.id] || null;
    e.last = Math.max(e.last, Number(new Date(c.properties.hs_timestamp)));
  }
  const dialsDetail = Object.values(byNum).map(e => ({ ...e, name: e.cid ? cname(e.cid) : null }))
    .sort((a, b) => b.last - a.last);

  const dials = { week: calls.length, today: calls.filter(c => inDay(c.properties.hs_timestamp)).length };
  const unique = { week: dialsDetail.length, today: dialsDetail.filter(e => e.today > 0).length };

  const mrow = m => ({ id: m.id, cid: mtgContact[m.id] || null, name: mtgContact[m.id] ? cname(mtgContact[m.id]) : (m.properties.hs_meeting_title || 'meeting'),
                       when: fmtT(m.properties.hs_timestamp), bookedAt: fmtT(m.properties.hs_createdate), ts: Number(new Date(m.properties.hs_timestamp)) });

  const sched = meetings.filter(m => m.properties.hs_meeting_source === 'MEETINGS_PUBLIC');
  const bookedWeek = sched.filter(m => Number(new Date(m.properties.hs_createdate)) >= weekStart);
  const bookedToday = bookedWeek.filter(m => Number(new Date(m.properties.hs_createdate)) >= dayStart);
  const thisWeekMtgs = meetings.filter(m => Number(new Date(m.properties.hs_timestamp)) >= weekStart);
  const byOutcome = o => thisWeekMtgs.filter(m => m.properties.hs_meeting_outcome === o).map(mrow).sort((a, b) => a.ts - b.ts);

  const completedRows = byOutcome('COMPLETED');
  const closesRows = completedRows.filter(r => {
    const p = r.cid && contacts[r.cid];
    return p && p.user_status === 'paid_customer';
  }).map(r => ({ ...r, status: 'paying customer' }));

  const actRows = wonDeals.map(d => {
    const cid = dealContact[d.id] || null;
    const wonTs = Number(new Date(d.properties.hs_v2_date_entered_decisionmakerboughtin));
    return {
      id: cid, name: cid ? cname(cid) : (d.properties.dealname || 'deal'),
      amount: parseFloat(d.properties.amount) || 0,
      date: new Date(wonTs).toLocaleDateString('en-AU', { timeZone: 'Australia/Melbourne', day: 'numeric', month: 'short' }),
      wonTs,
    };
  }).sort((a, b) => b.wonTs - a.wonTs);

  return {
    dials, unique, dialsDetail,
    booked: { week: bookedWeek.length, today: bookedToday.length },
    bookedRows: bookedWeek.map(mrow).sort((a, b) => a.ts - b.ts),
    completed: completedRows.length, completedRows,
    noShow: byOutcome('NO_SHOW').length, noShowRows: byOutcome('NO_SHOW'),
    canceled: byOutcome('CANCELED').length, canceledRows: byOutcome('CANCELED'),
    rescheduled: byOutcome('RESCHEDULED').length, rescheduledRows: byOutcome('RESCHEDULED'),
    upcoming: thisWeekMtgs.filter(m => ['SCHEDULED', null, undefined, ''].includes(m.properties.hs_meeting_outcome)).length,
    upcomingRows: thisWeekMtgs.filter(m => ['SCHEDULED', null, undefined, ''].includes(m.properties.hs_meeting_outcome)).map(mrow).sort((a, b) => a.ts - b.ts),
    closes: closesRows.length, closesRows,
    actWeek: actRows.length, actToday: actRows.filter(r => r.wonTs >= dayStart).length,
    actMrr: actRows.reduce((t, r) => t + r.amount, 0), actRows,
  };
}

let lucasCache = { data: null, time: 0, loading: null };
async function getLucas(force = false) {
  if (!force && lucasCache.data && Date.now() - lucasCache.time < CACHE_TTL_MS) return lucasCache.data;
  if (lucasCache.loading) return lucasCache.loading;
  lucasCache.loading = (async () => {
    try {
      const raw = await fetchLucasData();
      lucasCache.data = { ...lucasStats(raw), fetchedAt: raw.fetchedAt };
      lucasCache.time = Date.now();
      return lucasCache.data;
    } catch (err) {
      console.error('[lucas] fetch failed:', err.response?.status || err.message);
      return lucasCache.data;
    } finally { lucasCache.loading = null; }
  })();
  return lucasCache.loading;
}

function renderLucas(s) {
  if (!s) return `<!doctype html><html><body><p>Loading...</p><script>setTimeout(()=>location.reload(),3000)</script></body></html>`;
  const HS = 'https://app-na2.hubspot.com/contacts/244038625/record/0-1/';
  const link = (cid, name) => cid ? `<a href="${HS}${cid}" target="_blank">${name || 'contact'}</a>` : (name || '');
  const mtgTable = rows => rows.length ? `<table><thead><tr><th>Who</th><th>Meeting Time</th><th>Booked</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${link(r.cid, r.name)}</td><td>${r.when}</td><td>${r.bookedAt}</td></tr>`).join('')}</tbody></table>` : '<p class="none">None yet this week.</p>';
  const details = {
    dials: `<table><thead><tr><th>Who / Number</th><th>Attempts (wk)</th><th>Today</th></tr></thead><tbody>${
      s.dialsDetail.map(e => `<tr><td>${link(e.cid, e.name)} <span class="mut">${e.number}</span></td><td>${e.count}</td><td>${e.today || ''}</td></tr>`).join('')}</tbody></table>`,
    booked: mtgTable(s.bookedRows),
    completed: mtgTable(s.completedRows),
    noshow: mtgTable(s.noShowRows),
    canceled: mtgTable(s.canceledRows),
    resched: mtgTable(s.rescheduledRows),
    upcoming: mtgTable(s.upcomingRows),
    closes: s.closesRows.length ? `<table><thead><tr><th>Who</th><th>Meeting</th><th>Status</th></tr></thead><tbody>${
      s.closesRows.map(r => `<tr><td>${link(r.cid, r.name)}</td><td>${r.when}</td><td>${r.status}</td></tr>`).join('')}</tbody></table>` : '<p class="none">None yet this week.</p>',
    acts: s.actRows.length ? `<table><thead><tr><th>Who</th><th>Became Paying</th><th>$/mo</th></tr></thead><tbody>${
      s.actRows.map(r => `<tr><td>${link(r.id, r.name)}</td><td>${r.date}</td><td>${r.amount ? '$' + r.amount : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="none">None yet this week.</p>',
  };
  const tile = (big, lbl, sub, key) => `<div class="tile${key ? ' click' : ''}"${key ? ` onclick="show('${key}', this)"` : ''}><div class="big">${big}</div><div class="lbl">${lbl}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lucas Scorecard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fafafa;color:#1a1a1a;padding:32px 16px}
  .container{max-width:900px;margin:0 auto}
  h1{font-size:24px;font-weight:700;letter-spacing:-0.5px}
  .meta{color:#888;font-size:13px;margin:4px 0 20px}
  .meta a{color:#0066cc;text-decoration:none}
  h2{font-size:15px;font-weight:600;margin:22px 0 8px;color:#444}
  .wk{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
  .tile{background:#fff;border:1px solid #eee;border-radius:10px;padding:14px 16px;box-shadow:0 1px 3px rgba(0,0,0,0.03)}
  .tile.click{cursor:pointer}
  .tile.click:hover{border-color:#bbb}
  .tile.active{border-color:#0066cc;box-shadow:0 0 0 1px #0066cc}
  .big{font-size:26px;font-weight:700;letter-spacing:-0.5px}
  .lbl{font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px}
  .sub{font-size:11px;color:#aaa;margin-top:4px}
  .panel{display:none;background:#fff;border:1px solid #eee;border-radius:10px;margin-top:12px;padding:6px 0;overflow-x:auto}
  .panel.open{display:block}
  .panel table{width:100%;border-collapse:collapse;font-size:13px}
  .panel th{text-align:left;padding:8px 14px;color:#888;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid #f0f0f0}
  .panel td{padding:8px 14px;border-bottom:1px solid #f7f7f7}
  .panel tr:last-child td{border-bottom:none}
  .panel a{color:#0066cc;text-decoration:none}
  .panel .none{padding:12px 14px;color:#999;font-size:13px}
  .mut{color:#aaa;font-size:11px;margin-left:6px}
  .foot{color:#999;font-size:12px;margin-top:22px;line-height:1.6}
</style></head><body><div class="container">
  <h1>Lucas Scorecard</h1>
  <p class="meta">Updated ${fmtAge(s.fetchedAt)} &middot; Melbourne time &middot; click any tile to see the records behind it &middot; <a href="/lucas?force=1">refresh</a> &middot; <a href="/">attribution dashboard</a></p>
  <h2>Today</h2>
  <div class="wk">
    ${tile(s.dials.today, 'Dials', '', 'dials')}
    ${tile(s.unique.today, 'Unique Dials', '', 'dials')}
    ${tile(s.booked.today, 'Demos Booked', 'via scheduler', 'booked')}
    ${tile(s.actToday, 'Sales Made', 'new paying customers', 'acts')}
  </div>
  <h2>This Week (Mon to now)</h2>
  <div class="wk">
    ${tile(s.dials.week, 'Dials', '', 'dials')}
    ${tile(s.unique.week, 'Unique Dials', '', 'dials')}
    ${tile(s.booked.week, 'Demos Booked', 'via scheduler', 'booked')}
    ${tile(s.completed, 'Demos Completed', '', 'completed')}
    ${tile(s.closes, 'Closed on Demo', 'completed + activated', 'closes')}
    ${tile(s.actWeek, 'Sales Made', '$' + Math.round(s.actMrr) + '/mo added', 'acts')}
  </div>
  <h2>Meeting Outcomes This Week</h2>
  <div class="wk">
    ${tile(s.noShow, 'No Shows', '', 'noshow')}
    ${tile(s.canceled, 'Canceled', '', 'canceled')}
    ${tile(s.rescheduled, 'Rescheduled', '', 'resched')}
    ${tile(s.upcoming, 'Upcoming / Unmarked', 'outcome not set yet', 'upcoming')}
  </div>
  ${Object.entries(details).map(([k, html]) => `<div class="panel" id="p-${k}">${html}</div>`).join('')}
  <p class="foot">
    Dials = outbound calls owned by Lucas. Unique = distinct numbers dialed; the dials panel shows attempts per person.
    Demos Booked = meetings created via the scheduling page this week. Outcome tiles cover meetings taking place this week; set the outcome on each meeting to keep these true.
    Closed on Demo = contacts from this week's completed meetings who are now paying customers. Sales Made = deals reaching the won stage this week (moved automatically when a customer starts paying), any source.
    Names link to the HubSpot record. Data refreshes every 5 minutes.
  </p>
</div>
<script>
function show(key, el) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('open'));
  document.querySelectorAll('.tile').forEach(t => t.classList.remove('active'));
  const p = document.getElementById('p-' + key);
  if (el.dataset.open === key) { el.dataset.open = ''; return; }
  p.classList.add('open'); el.classList.add('active'); el.dataset.open = key;
  p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
</script>
</body></html>`;
}

const app = express();
app.get('/health', (req, res) => res.send('ok'));
app.get('/api/data', async (req, res) => {
  const data = await getData(req.query.force === '1');
  if (!data) return res.status(503).json({ status: 'loading', error: cache.error });
  res.json(data);
});
app.get('/api/lucas', async (req, res) => {
  const d = await getLucas(req.query.force === '1');
  if (!d) return res.status(503).json({ status: 'loading' });
  res.json(d);
});
app.get('/lucas', async (req, res) => {
  const d = await getLucas(req.query.force === '1');
  res.type('html').send(renderLucas(d));
});
app.get('/', async (req, res) => {
  const data = await getData(req.query.force === '1');
  res.type('html').send(renderHTML(data, cache.error));
});

app.listen(PORT, () => {
  console.log(`Sammy Attribution on :${PORT}`);
  getData(true);
});
