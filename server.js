require('dotenv').config();
const express = require('express');
const axios = require('axios');

const TOKEN = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
if (!TOKEN) { console.error('HUBSPOT_PRIVATE_APP_TOKEN required'); process.exit(1); }

const PORT = process.env.PORT || 3000;
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

async function fetchData() {
  const paidCustomers = await searchContacts(
    [{ propertyName: 'user_status', operator: 'EQ', value: 'paid_customer' }],
    ['email', 'original_source_channel', 'sammy_pricing_plan', 'sammy_subscription_tier'],
  );

  const thirtyDaysAgoMs = Date.now() - 30 * 86400000;
  const recent = await searchContacts(
    [{ propertyName: 'createdate', operator: 'GTE', value: String(thirtyDaysAgoMs) }],
    ['email', 'original_source_channel', 'createdate'],
  );

  return { paidCustomers, recent, fetchedAt: new Date().toISOString() };
}

function aggregate({ paidCustomers, recent }) {
  const init = {};
  for (const c of CHANNELS) init[c.key] = { customers: 0, mrr: 0, new30d: 0 };
  init['_unknown'] = { customers: 0, mrr: 0, new30d: 0 };

  for (const c of paidCustomers) {
    const ch = c.properties.original_source_channel || '_unknown';
    const bucket = init[ch] || init['_unknown'];
    bucket.customers += 1;
    const plan = c.properties.sammy_pricing_plan;
    const price = PLAN_PRICING[plan] ?? PLAN_PRICING.default;
    bucket.mrr += price;
  }
  for (const c of recent) {
    const ch = c.properties.original_source_channel || '_unknown';
    const bucket = init[ch] || init['_unknown'];
    bucket.new30d += 1;
  }

  const rows = CHANNELS.map(c => {
    const a = init[c.key];
    const roi = c.cost > 0 ? Math.round(((a.mrr - c.cost) / c.cost) * 100) : null;
    return { key: c.key, label: c.label, cost: c.cost, customers: a.customers, mrr: a.mrr, new30d: a.new30d, roi };
  });

  rows.sort((a, b) => b.mrr - a.mrr || b.customers - a.customers);

  const totals = rows.reduce((t, r) => ({
    customers: t.customers + r.customers,
    mrr: t.mrr + r.mrr,
    new30d: t.new30d + r.new30d,
    cost: t.cost + r.cost,
  }), { customers: 0, mrr: 0, new30d: 0, cost: 0 });
  totals.roi = totals.cost > 0 ? Math.round(((totals.mrr - totals.cost) / totals.cost) * 100) : null;

  const unknown = init['_unknown'];

  return { rows, totals, unknown };
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
  if (!iso) return '—';
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
  const { rows, totals, unknown, fetchedAt } = data;
  const rowHtml = rows.map(r => `
    <tr class="${r.customers === 0 && r.new30d === 0 ? 'dim' : ''}">
      <td class="label">${r.label}</td>
      <td class="num">${r.customers}</td>
      <td class="num">${fmtMoney(r.mrr)}</td>
      <td class="num">${r.new30d}</td>
      <td class="num">${r.cost > 0 ? fmtMoney(r.cost) : '<span class="muted">—</span>'}</td>
      <td class="num">${fmtROI(r.roi)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sammy Attribution</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fafafa;color:#1a1a1a;padding:32px 16px;min-height:100vh}
  .container{max-width:880px;margin:0 auto}
  h1{font-size:24px;font-weight:700;margin-bottom:4px;letter-spacing:-0.5px}
  .meta{color:#888;font-size:13px;margin-bottom:24px}
  .meta .refresh{color:#0066cc;cursor:pointer;text-decoration:none}
  .meta .refresh:hover{text-decoration:underline}
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
      <tbody>${rowHtml}</tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td class="num">${totals.customers}</td>
          <td class="num">${fmtMoney(totals.mrr)}</td>
          <td class="num">${totals.new30d}</td>
          <td class="num">${fmtMoney(totals.cost)}</td>
          <td class="num">${fmtROI(totals.roi)}</td>
        </tr>
      </tfoot>
    </table>
  </div>
  ${unknown.customers > 0 || unknown.new30d > 0 ? `<div class="unknown-warning"><strong>${unknown.customers}</strong> paying customer(s) and <strong>${unknown.new30d}</strong> recent contact(s) have no <code>original_source_channel</code> set yet. Run the attribution backfill to classify them.</div>` : ''}
  <p class="footnote">
    Customers = paying subscribers grouped by their <code>original_source_channel</code>.
    MRR = sum of plan price per customer. New (30d) = contacts created in the last 30 days.
    Cost/mo is the monthly spend allocated to each channel.
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
