/**
 * CMM Ads Intelligence — Cloudflare Worker proxy
 * ------------------------------------------------------------------
 * Handles the data sources the app sends:
 *   google_ads      { customerId, gaql, managerId? }
 *   meta_ads        { path, params, useAsync?, adAccountId? }
 *   meta_accounts   {}                    <-- the fix for "Unknown source"
 *   tiktok_ads      { path?, advertiserId?, ... }   (optional)
 *   linkedin_ads    { ... }                          (optional stub)
 *
 * Secrets (Worker → Settings → Variables):
 *   AUTH_SECRET                  – must match the app's "Worker Auth Token"
 *   META_ACCESS_TOKEN            – Meta (system-user) token, never-expiring
 *   META_AD_ACCOUNT_ID           – default ad account digits (fallback)
 *   GOOGLE_ADS_DEVELOPER_TOKEN
 *   GOOGLE_ADS_CLIENT_ID
 *   GOOGLE_ADS_CLIENT_SECRET
 *   GOOGLE_ADS_REFRESH_TOKEN
 *   (optional) TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID, LINKEDIN_ACCESS_TOKEN
 * ------------------------------------------------------------------
 */

const META_V = 'v21.0';
const GOOGLE_V = 'v21';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth-Token',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);

    // Auth — matches the "Worker Auth Token" field in the app's Config
    if (env.AUTH_SECRET) {
      const tok = request.headers.get('X-Auth-Token') || '';
      if (tok !== env.AUTH_SECRET) return json({ error: 'Unauthorized' }, 401);
    }

    let body;
    try { body = await request.json(); }
    catch (_) { return json({ error: 'Invalid JSON body' }, 400); }

    const source = body.source;
    try {
      if (source === 'google_ads')    return await googleAds(body, env);
      if (source === 'meta_ads')      return await metaAds(body, env);
      if (source === 'meta_accounts') return await metaAccounts(env);
      if (source === 'tiktok_ads')    return await tiktokAds(body, env);
      if (source === 'linkedin_ads')  return await linkedinAds(body, env);
      return json({ error: 'Unknown source: ' + source }, 400);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 200);
    }
  },
};

/* ── META: list ad accounts on the token ──────────────────────────── */
async function metaAccounts(env) {
  const token = env.META_ACCESS_TOKEN;
  if (!token) return json({ error: 'META_ACCESS_TOKEN secret is not set' });

  const fields = 'name,account_status,currency,timezone_name';
  const url = `https://graph.facebook.com/${META_V}/me/adaccounts?fields=${fields}&limit=500&access_token=${encodeURIComponent(token)}`;
  const fb = await (await fetch(url)).json();
  if (fb.error) return json({ error: 'Facebook: ' + (fb.error.message || 'Graph error') });

  const accounts = (fb.data || []).map((a) => ({
    id: a.id,                          // already "act_XXXXXXXX"
    name: a.name || a.id,
    account_status: a.account_status,  // 1 = active
    currency: a.currency,
    timezone: a.timezone_name,
  }));
  return json({ accounts });
}

/* ── META: ads data (sync GET, or async insights report) ──────────── */
async function metaAds(body, env) {
  const token = env.META_ACCESS_TOKEN;
  if (!token) return json({ error: 'META_ACCESS_TOKEN secret is not set' });

  // ad account (app sends "act_..."; else fall back to the secret)
  let acct = body.adAccountId || ('act_' + String(env.META_AD_ACCOUNT_ID || '').replace(/^act_/, ''));
  if (!/^act_/.test(acct)) acct = 'act_' + acct;

  // path is relative to the ad account (e.g. "/insights", "/ads", "/campaigns"),
  // but if it starts with a node id or act_, treat it as an absolute Graph path.
  let path = body.path || '';
  if (path && path[0] !== '/') path = '/' + path;
  const absolute = /^\/(act_|\d+)/.test(path);
  const baseNode = absolute
    ? `https://graph.facebook.com/${META_V}${path}`
    : `https://graph.facebook.com/${META_V}/${acct}${path}`;

  const params = body.params || {};
  const toForm = (extra) => {
    const q = new URLSearchParams();
    for (const k in params) q.set(k, typeof params[k] === 'object' ? JSON.stringify(params[k]) : params[k]);
    if (extra) for (const k in extra) q.set(k, extra[k]);
    q.set('access_token', token);
    return q;
  };

  // Async insights: create job → poll → fetch results
  if (body.useAsync && /insights/.test(path)) {
    const runRes = await (await fetch(baseNode, { method: 'POST', body: toForm() })).json();
    if (runRes.error) return json({ error: 'Facebook: ' + runRes.error.message });
    const runId = runRes.report_run_id;
    if (!runId) return json({ error: 'Meta returned no report_run_id' });

    let status = '', tries = 0;
    while (tries++ < 28) {
      await sleep(2000);
      const st = await (await fetch(
        `https://graph.facebook.com/${META_V}/${runId}?fields=async_status,async_percent_completion&access_token=${encodeURIComponent(token)}`
      )).json();
      status = st.async_status;
      if (status === 'Job Completed') break;
      if (status === 'Job Failed' || status === 'Job Skipped') return json({ error: 'Async job ' + status });
    }
    const out = await (await fetch(
      `https://graph.facebook.com/${META_V}/${runId}/insights?limit=500&access_token=${encodeURIComponent(token)}`
    )).json();
    if (out.error) return json({ error: 'Facebook: ' + out.error.message });
    const rows = out.data || [];
    return json({ data: rows, total: rows.length, async: true, truncated: !!out.paging?.next });
  }

  // Sync GET
  const url = `${baseNode}?${toForm().toString()}`;
  const data = await (await fetch(url)).json();
  if (data.error) return json({ error: 'Facebook: ' + data.error.message });
  const rows = data.data || [];
  return json({ data: rows, total: rows.length, truncated: !!data.paging?.next });
}

/* ── GOOGLE ADS: GAQL via searchStream ────────────────────────────── */
async function googleAds(body, env) {
  const { customerId, gaql, managerId } = body;
  if (!customerId || !gaql) return json({ error: 'customerId and gaql are required' });

  const dev = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!dev) return json({ error: 'GOOGLE_ADS_DEVELOPER_TOKEN secret is not set' });

  const tok = await googleAccessToken(env);
  if (tok.error) return json({ error: tok.error });

  const cid = String(customerId).replace(/-/g, '');
  const headers = {
    Authorization: 'Bearer ' + tok.token,
    'developer-token': dev,
    'Content-Type': 'application/json',
  };
  if (managerId) headers['login-customer-id'] = String(managerId).replace(/-/g, '');

  const url = `https://googleads.googleapis.com/${GOOGLE_V}/customers/${cid}/googleAds:searchStream`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query: gaql }) });
  const text = await res.text();
  if (!res.ok) return json({ error: 'Google ' + res.status + ': ' + text.slice(0, 400) });

  // searchStream returns an array of { results: [...] } batches — flatten them.
  let batches;
  try { batches = JSON.parse(text); } catch (_) { return json({ error: 'Bad Google response' }); }
  const results = [];
  (Array.isArray(batches) ? batches : [batches]).forEach((b) => { if (b && b.results) results.push(...b.results); });
  return json({ results, count: results.length });
}

async function googleAccessToken(env) {
  for (const k of ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN']) {
    if (!env[k]) return { error: k + ' secret is not set' };
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_ADS_CLIENT_ID,
      client_secret: env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (d.error) return { error: 'Google OAuth: ' + (d.error_description || d.error) };
  return { token: d.access_token };
}

/* ── TIKTOK (optional) ────────────────────────────────────────────── */
async function tiktokAds(body, env) {
  const token = env.TIKTOK_ACCESS_TOKEN;
  const adv = body.advertiserId || env.TIKTOK_ADVERTISER_ID;
  if (!token || !adv) return json({ error: 'TikTok not configured (set TIKTOK_ACCESS_TOKEN + TIKTOK_ADVERTISER_ID)' });

  const base = 'https://business-api.tiktok.com/open_api/v1.3';
  const path = body.path || '/report/integrated/get/';
  const skip = ['source', 'path', 'advertiserId', 'description'];
  const q = new URLSearchParams({ advertiser_id: adv });
  for (const k in body) {
    if (skip.includes(k)) continue;
    const v = body[k];
    q.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
  }
  const data = await (await fetch(base + path + '?' + q.toString(), { headers: { 'Access-Token': token } })).json();
  return json(data);
}

/* ── LINKEDIN (optional stub) ─────────────────────────────────────── */
async function linkedinAds(body, env) {
  const token = env.LINKEDIN_ACCESS_TOKEN;
  if (!token) return json({ error: 'LinkedIn not configured (set LINKEDIN_ACCESS_TOKEN)' });
  // Fill in your exact LinkedIn Marketing API call here if you use it.
  return json({ error: 'LinkedIn handler not implemented — send me your query shape to complete it.' });
}
