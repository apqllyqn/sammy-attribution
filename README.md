# Sammy Attribution Dashboard

Single-page dashboard at https://attribution.hirecharm.com showing the 7 attribution channels with paying customers, MRR, recent signups, cost, and ROI.

## Run locally

```bash
cp .env.example .env
# fill in HUBSPOT_PRIVATE_APP_TOKEN
npm install
npm start
```

Open http://localhost:3000.

## Deploy

- Hosted on Coolify, same server as `sammy.hirecharm.com`.
- Dockerfile build, port 3000, `/health` check.
- Env var: `HUBSPOT_PRIVATE_APP_TOKEN`.

## What it shows

| Column | Source |
|---|---|
| Channel | One of 7: cold_call, cold_email, linkedin_automation, paid_ads, organic_inbound, user_generated, referral |
| Customers | HubSpot contacts with `user_status = paid_customer`, grouped by `original_source_channel` |
| MRR | Sum of plan price per customer ($59 founder / $99 monthly / $79 annual-equiv / $0 free) |
| New (30d) | Contacts with `createdate` in last 30 days |
| Cost/mo | Hardcoded constants in `server.js` |
| ROI | `(MRR - Cost) / Cost × 100` |

Data caches 5 min server-side. `?force=1` forces a fresh fetch.

## V2 (not built)

See `docs/superpowers/specs/2026-05-18-sammy-attribution-dashboard-design.md` for the future scope: avg touches per conversion, multi-touch channel sequences, time windows, drill-down.
