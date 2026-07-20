# Campaign Forge AI — Cloudflare Worker Proxy
## Deployment Guide

This Worker is a thin, stateless proxy that sits between the Campaign Forge AI
browser app and IBM watsonx.ai. It holds the IBM Cloud API key as an encrypted
Cloudflare Worker Secret so it is never exposed to the browser.

```
Browser (HTML/JS)
    │  POST /analyze  { input, model, parameters }
    ▼
Cloudflare Worker  (this file)
    ├─ POST iam.cloud.ibm.com  → exchange IBM_API_KEY for bearer token
    └─ POST ml.cloud.ibm.com   → Granite inference
    │  { result: "..." }
    ▼
Browser  → parseGraniteResponse() → Expert Review Room
```

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 18 + | https://nodejs.org |
| Wrangler CLI | 3 + | `npm install -g wrangler` |
| Cloudflare account | Free tier is sufficient | https://dash.cloudflare.com/sign-up |

---

## Step 1 — Install Wrangler and log in

```bash
npm install -g wrangler
wrangler login
```

This opens a browser window. Authorise Wrangler to access your Cloudflare account.

---

## Step 2 — Clone / enter the worker directory

```bash
# From the project root
cd cloudflare-worker
```

The directory contains:
```
cloudflare-worker/
├── worker.js       ← The Worker source code
└── wrangler.toml   ← Cloudflare configuration
```

No `npm install` is required — the Worker uses only the built-in Cloudflare
`fetch` API and has zero npm dependencies.

---

## Step 3 — Edit wrangler.toml

Open `wrangler.toml` and set your real watsonx.ai Project ID:

```toml
[vars]
WATSONX_ENDPOINT   = "https://us-south.ml.cloud.ibm.com"
WATSONX_PROJECT_ID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Replace `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` with the UUID shown in your
watsonx.ai project under **Manage → General → Project ID**.

Change `WATSONX_ENDPOINT` if your IBM Cloud region is not `us-south`:

| Region | Endpoint |
|---|---|
| Dallas (us-south) | `https://us-south.ml.cloud.ibm.com` |
| Frankfurt (eu-de) | `https://eu-de.ml.cloud.ibm.com` |
| London (eu-gb) | `https://eu-gb.ml.cloud.ibm.com` |
| Tokyo (jp-tok) | `https://jp-tok.ml.cloud.ibm.com` |

---

## Step 4 — Add the IBM Cloud API Key as a Secret

```bash
wrangler secret put IBM_API_KEY
```

Wrangler will prompt:
```
Enter a secret value: ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
```

Paste your IBM Cloud API key and press Enter.

The key is encrypted at rest in Cloudflare's secret store and is **never**
written to `wrangler.toml`, source code, or any log.

To generate an IBM Cloud API key:
1. Go to https://cloud.ibm.com/iam/apikeys
2. Click **Create an IBM Cloud API key**
3. Copy the key immediately — it is only shown once

---

## Step 5 — Deploy the Worker

```bash
wrangler deploy
```

Expected output:
```
✨ Successfully published your Worker

https://campaign-forge-ai-proxy.YOUR-SUBDOMAIN.workers.dev
```

Copy the full `*.workers.dev` URL — you will need it in Step 7.

---

## Step 6 — Verify the Worker is live

```bash
curl -X POST https://campaign-forge-ai-proxy.YOUR-SUBDOMAIN.workers.dev/test \
  -H "Content-Type: application/json" \
  -d '{"model":"ibm/granite-3-8b-instruct","input":"ping"}'
```

Expected response:
```json
{"ok":true,"message":"IBM Granite connected."}
```

If you see `{"error":"Worker is not configured: IBM_API_KEY secret is missing"}`,
re-run Step 4.

---

## Step 7 — Update Campaign Forge AI with the Worker URL

Open `campaign-forge-ai.html` and locate the **AI Settings** panel (⚙ AI Settings
button in the wizard nav bar).

In the **watsonx.ai API Endpoint** field, enter your Worker URL:
```
https://campaign-forge-ai-proxy.YOUR-SUBDOMAIN.workers.dev
```

The frontend now sends all AI requests to your Worker instead of IBM directly.
The **IBM Cloud API Key** field in the UI is no longer used by the proxy
architecture — leave it blank or enter any placeholder value.

---

## Environment Variables Reference

| Name | Where | Description |
|---|---|---|
| `IBM_API_KEY` | Cloudflare Secret | IBM Cloud API key — never in source code |
| `WATSONX_ENDPOINT` | `wrangler.toml [vars]` | Regional watsonx.ai base URL |
| `WATSONX_PROJECT_ID` | `wrangler.toml [vars]` | watsonx.ai project UUID |

---

## Worker Routes

| Method | Path | Description |
|---|---|---|
| `POST` | `/analyze` | Full campaign analysis — calls Granite with the complete prompt |
| `POST` | `/test` | Connectivity test — 1-token ping to verify IAM + Granite are reachable |
| `OPTIONS` | `*` | CORS preflight — returns 204 with CORS headers |

---

## Updating the Worker

After any edit to `worker.js`:
```bash
wrangler deploy
```

After changing a secret:
```bash
wrangler secret put IBM_API_KEY
```

To change `WATSONX_PROJECT_ID`, edit `wrangler.toml` and re-deploy:
```bash
wrangler deploy
```

---

## Restricting Origins in Production

By default the Worker returns `Access-Control-Allow-Origin: *`.
To restrict it to your domain, edit the `corsHeaders()` function in `worker.js`:

```js
function corsHeaders(origin) {
  const allowed = 'https://yourdomain.com';
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}
```

Then redeploy.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `IBM_API_KEY secret is missing` | Secret not set | Re-run `wrangler secret put IBM_API_KEY` |
| `WATSONX_PROJECT_ID env var is missing` | Not set in wrangler.toml | Edit `wrangler.toml`, redeploy |
| `IAM token exchange failed (400)` | Invalid API key | Regenerate at cloud.ibm.com/iam/apikeys |
| `watsonx.ai error (404)` | Wrong project ID or endpoint | Verify both in wrangler.toml |
| `watsonx.ai error (403)` | API key lacks watsonx.ai IAM access | Add `Machine Learning` service to IAM policy |
| Browser: `Network error reaching proxy` | Wrong Worker URL in AI Settings | Paste the `*.workers.dev` URL into Endpoint field |
