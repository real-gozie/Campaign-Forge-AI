/**
 * Campaign Forge AI — Cloudflare Worker Proxy
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   1. Receive a POST /analyze request from the Campaign Forge AI browser app
 *   2. Exchange the IBM Cloud API key (stored as a Worker Secret) for an
 *      IAM bearer token via IBM's standard OAuth2 token endpoint
 *   3. Forward the prompt to the selected watsonx.ai / Granite model
 *   4. Return the raw generated_text back to the browser as JSON
 *
 * What this Worker does NOT do:
 *   - Store any data (no KV, no D1, no R2)
 *   - Authenticate users (open proxy — restrict origins in production)
 *   - Log or retain campaign inputs
 *
 * Required Cloudflare Worker Secrets (set via `wrangler secret put`):
 *   IBM_API_KEY          — your IBM Cloud API key
 *
 * Required environment variables (set in wrangler.toml [vars]):
 *   WATSONX_ENDPOINT     — e.g. https://us-south.ml.cloud.ibm.com
 *   WATSONX_PROJECT_ID   — your watsonx.ai project UUID
 *
 * Routes served:
 *   POST /analyze        — main inference proxy (campaign analysis)
 *   POST /test           — lightweight connectivity test (1-token ping)
 *   OPTIONS *            — CORS preflight
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── IAM token cache (lives for the duration of a Worker isolate — typically minutes)
let cachedToken    = null;
let tokenExpiresAt = 0;

// ── CORS headers returned on every response ──────────────────────────────────
function corsHeaders(origin) {
  // In production, replace '*' with your exact domain, e.g. 'https://yourapp.com'
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age':       '86400',
  };
}

function jsonResponse(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

function errorResponse(message, status, origin) {
  return jsonResponse({ error: message }, status, origin);
}

// ── IBM IAM token exchange ────────────────────────────────────────────────────
// Token lifetime is 1 hour; we refresh 5 minutes early to avoid mid-flight expiry.
async function getIBMToken(apiKey) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey:     apiKey,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`IAM token exchange failed (${res.status}): ${body.substring(0, 120)}`);
  }

  const data = await res.json();
  cachedToken    = data.access_token;
  // IBM IAM tokens expire in 3600s; cache for 3300s (55 minutes)
  tokenExpiresAt = now + (data.expires_in ? (data.expires_in - 300) * 1000 : 3300000);
  return cachedToken;
}

// ── watsonx.ai inference call ─────────────────────────────────────────────────
async function callWatsonx(token, endpoint, projectId, modelId, input, parameters) {
  const url = `${endpoint}/ml/v1/text/generation?version=2023-05-29`;

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      model_id:   modelId,
      project_id: projectId,
      input,
      parameters: parameters || {
        decoding_method:   'greedy',
        max_new_tokens:    3000,
        min_new_tokens:    200,
        repetition_penalty: 1.05,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`watsonx.ai error (${res.status}): ${body}`);
  }

  const data = await res.json();
  const text = data?.results?.[0]?.generated_text ?? '';
  return text;
}

// ── Main request handler ──────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';
    const url    = new URL(request.url);

    // Handle CORS preflight for all routes
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only accept POST
    if (request.method !== 'POST') {
      return errorResponse('Method not allowed', 405, origin);
    }

    // ── Validate required secrets / env vars are present ─────────────────────
    if (!env.IBM_API_KEY) {
      return errorResponse(
        'Worker is not configured: IBM_API_KEY secret is missing. ' +
        'Run: wrangler secret put IBM_API_KEY',
        500, origin
      );
    }
    const endpoint  = env.WATSONX_ENDPOINT  || 'https://us-south.ml.cloud.ibm.com';
    const projectId = env.WATSONX_PROJECT_ID || '';

    if (!projectId) {
      return errorResponse(
        'Worker is not configured: WATSONX_PROJECT_ID env var is missing. ' +
        'Add it to wrangler.toml [vars].',
        500, origin
      );
    }

    // ── Parse request body ────────────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch (_) {
      return errorResponse('Invalid JSON body', 400, origin);
    }

    const { input, model, parameters } = body;

    if (!input || typeof input !== 'string') {
      return errorResponse('Missing required field: input', 400, origin);
    }

    const modelId = model || 'ibm/granite-3-8b-instruct';

    try {
      // ── Route: /test — lightweight 1-token connectivity ping ─────────────────
      if (url.pathname === '/test') {
        const token = await getIBMToken(env.IBM_API_KEY);
        const testInput = '<|system|>\nRespond with exactly two words.\n<|user|>\nSay: connected\n<|assistant|>\n';
        await callWatsonx(token, endpoint, projectId, modelId, testInput,
          { decoding_method: 'greedy', max_new_tokens: 8 }
        );
        return jsonResponse({ ok: true, message: 'IBM Granite connected.' }, 200, origin);
      }

      // ── Route: /analyze — full campaign analysis ──────────────────────────────
      if (url.pathname === '/analyze') {
        const token  = await getIBMToken(env.IBM_API_KEY);
        const result = await callWatsonx(token, endpoint, projectId, modelId, input, parameters);
        return jsonResponse({ result }, 200, origin);
      }

      return errorResponse('Unknown route', 404, origin);

    } catch (err) {
      console.error("Worker Error:", err);
      // Structured error — message is safe to surface to the browser
      return errorResponse(err.message, 502, origin);
    }
  },
};