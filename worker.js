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
 *   (optional) TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID
 *   (optional) LINKEDIN_ACCESS_TOKEN, LINKEDIN_AD_ACCOUNT_ID, LINKEDIN_VERSION
 *   Platform tokens may also arrive per-request as body.accessToken (set in the
 *   app's Configuration) — worker secrets take precedence when both exist.
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
      if (source === 'claude')        return await claude(body, env);
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

/* ── CLAUDE: proxy to Anthropic so the API key stays server-side ───── */
async function claude(body, env) {
  const key = env.ANTHROPIC_API_KEY || env.CLAUDE_KEY || env.CLAUDE_API_KEY || env.ANTHROPIC_KEY;
  if (!key) return json({ error: 'ANTHROPIC_API_KEY secret is not set on the worker' });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: body.model || 'claude-sonnet-5',
      max_tokens: body.max_tokens || 8192,
      system: body.system,
      tools: body.tools,
      messages: body.messages,
    }),
  });
  const text = await r.text();
  return new Response(text, { status: r.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

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

/* ── TIKTOK Ads ───────────────────────────────────────────────────── */
async function tiktokAds(body, env) {
  const token = env.TIKTOK_ACCESS_TOKEN || body.accessToken;
  const adv = body.advertiserId || env.TIKTOK_ADVERTISER_ID;
  if (!token) return json({ error: 'TikTok not configured — set the TIKTOK_ACCESS_TOKEN worker secret, or add your token in the app Configuration' });
  if (!adv) return json({ error: 'No TikTok advertiser ID (set it in the app Config, or TIKTOK_ADVERTISER_ID secret)' });

  const base = 'https://business-api.tiktok.com/open_api/v1.3';
  const action = body.action || 'report';

  const dataLevel = (dims) => {
    const d = (dims || []).join(',');
    if (d.includes('ad_id')) return 'AUCTION_AD';
    if (d.includes('adgroup_id')) return 'AUCTION_ADGROUP';
    if (d.includes('campaign_id')) return 'AUCTION_CAMPAIGN';
    return 'AUCTION_ADVERTISER';
  };
  const qs = (obj) => {
    const q = new URLSearchParams();
    for (const k in obj) {
      const v = obj[k];
      if (v === undefined || v === null || v === '') continue;
      q.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
    }
    return q.toString();
  };

  // TikTok BASIC reports require an explicit date range — default to last 30 days.
  const day = (d) => d.toISOString().slice(0, 10);
  const endDate = body.endDate || day(new Date());
  const startDate = body.startDate || day(new Date(Date.now() - 30 * 864e5));

  let url;
  if (action === 'report') {
    const dims = body.dimensions || ['campaign_id'];
    const params = {
      advertiser_id: adv,
      report_type: body.reportType || 'BASIC',
      data_level: dataLevel(dims),
      dimensions: dims,
      metrics: body.metrics || ['spend', 'impressions', 'clicks', 'ctr', 'cpc'],
      start_date: startDate,
      end_date: endDate,
      page_size: body.pageSize || 1000,
    };
    if (body.orderField) params.order_field = body.orderField;
    if (body.orderType) params.order_type = body.orderType;
    if (body.filters) params.filtering = body.filters;
    else if (body.campaignIds) params.filtering = [{ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify(body.campaignIds) }];
    url = base + '/report/integrated/get/?' + qs(params);
  } else {
    const ep = action === 'campaigns' ? '/campaign/get/' : action === 'adgroups' ? '/adgroup/get/' : '/ad/get/';
    const params = { advertiser_id: adv, page_size: body.pageSize || 100 };
    if (body.fields) params.fields = body.fields;
    const flt = [];
    if (body.campaignIds) flt.push({ field_name: 'campaign_ids', filter_type: 'IN', filter_value: JSON.stringify(body.campaignIds) });
    if (body.adgroupIds) flt.push({ field_name: 'adgroup_ids', filter_type: 'IN', filter_value: JSON.stringify(body.adgroupIds) });
    if (body.filters) params.filtering = body.filters;
    else if (flt.length) params.filtering = flt;
    url = base + ep + '?' + qs(params);
  }

  const resp = await (await fetch(url, { headers: { 'Access-Token': token } })).json();
  if (resp.code !== 0) return json({ error: 'TikTok ' + resp.code + ': ' + (resp.message || 'error') });
  const list = (resp.data && resp.data.list) ? resp.data.list : (Array.isArray(resp.data) ? resp.data : []);
  return json({ data: list, total: list.length, page_info: resp.data && resp.data.page_info });
}

/* ── LINKEDIN Marketing API ───────────────────────────────────────── */
// Actions: analytics (default) | campaigns | campaign_groups | creatives | accounts
// Uses the versioned REST API (Restli 2.0). Parentheses in Restli query
// syntax must stay raw — never run these query strings through URLSearchParams.
async function linkedinAds(body, env) {
  let token = env.LINKEDIN_ACCESS_TOKEN || body.accessToken;
  if (!token) return json({ error: 'LinkedIn not configured — set the LINKEDIN_ACCESS_TOKEN worker secret, or add your token in the app Configuration' });

  const LI_V = env.LINKEDIN_VERSION || '202506';
  const BASE = 'https://api.linkedin.com/rest';
  const acctId = String(body.accountId || env.LINKEDIN_AD_ACCOUNT_ID || '')
    .replace(/^urn:li:sponsoredAccount:/, '').trim();
  const action = body.action || 'analytics';
  const count = Math.min(Number(body.count) || 50, 100);

  const mkHeaders = () => ({
    Authorization: 'Bearer ' + token,
    'LinkedIn-Version': LI_V,
    'X-Restli-Protocol-Version': '2.0.0',
  });

  // Refresh-on-401: needs a refresh token (secret or app config) plus
  // LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET worker secrets.
  const refreshToken = env.LINKEDIN_REFRESH_TOKEN || body.refreshToken;
  let refreshed = false;
  const tryRefresh = async () => {
    if (refreshed || !refreshToken || !env.LINKEDIN_CLIENT_ID || !env.LINKEDIN_CLIENT_SECRET) return false;
    refreshed = true;
    const r = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: env.LINKEDIN_CLIENT_ID,
        client_secret: env.LINKEDIN_CLIENT_SECRET,
      }),
    });
    const d = await r.json().catch(() => null);
    if (d && d.access_token) { token = d.access_token; return true; }
    return false;
  };

  const liFetch = async (url) => {
    let res = await fetch(url, { headers: mkHeaders() });
    if (res.status === 401 && await tryRefresh()) {
      res = await fetch(url, { headers: mkHeaders() });
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.message || data.error_description)) || text.slice(0, 300);
      return { error: 'LinkedIn ' + res.status + ': ' + msg };
    }
    return { data };
  };

  // Restli date helper: (start:(year:Y,month:M,day:D),end:(...))
  const dpart = (d) => `(year:${d.getUTCFullYear()},month:${d.getUTCMonth() + 1},day:${d.getUTCDate()})`;
  const parseDay = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };

  if (action === 'accounts') {
    const r = await liFetch(`${BASE}/adAccounts?q=search&pageSize=${count}`);
    if (r.error) return json(r);
    const rows = r.data.elements || [];
    return json({ data: rows, total: rows.length });
  }

  if (!acctId) return json({ error: 'No LinkedIn ad account ID — set it in the app Configuration (numeric ID), or use action:"accounts" to list accessible accounts' });

  if (action === 'campaigns' || action === 'campaign_groups') {
    const node = action === 'campaigns' ? 'adCampaigns' : 'adCampaignGroups';
    let url = `${BASE}/adAccounts/${acctId}/${node}?q=search&pageSize=${count}&sortOrder=DESCENDING`;
    if (body.status) url += `&search=(status:(values:List(${encodeURIComponent(body.status)})))`;
    const r = await liFetch(url);
    if (r.error) return json(r);
    const rows = r.data.elements || [];
    return json({ data: rows, total: rows.length });
  }

  if (action === 'creatives') {
    let url = `${BASE}/adAccounts/${acctId}/creatives?q=criteria&pageSize=${count}`;
    if (body.campaignId) {
      const urn = encodeURIComponent(`urn:li:sponsoredCampaign:${String(body.campaignId).replace(/^urn:li:sponsoredCampaign:/, '')}`);
      url += `&campaigns=List(${urn})`;
    }
    const r = await liFetch(url);
    if (r.error) return json(r);
    const rows = r.data.elements || [];
    return json({ data: rows, total: rows.length });
  }

  // ── analytics (default) ──
  const end = body.endDate ? parseDay(body.endDate) : new Date();
  const start = body.startDate ? parseDay(body.startDate) : new Date(end.getTime() - 30 * 864e5);
  const dateRange = `(start:${dpart(start)},end:${dpart(end)})`;
  const pivot = body.pivot || 'CAMPAIGN';
  const granularity = body.timeGranularity || 'ALL';
  const metrics = (Array.isArray(body.metrics) && body.metrics.length ? body.metrics
    : ['impressions', 'clicks', 'costInLocalCurrency', 'externalWebsiteConversions']).slice(0, 18);
  const fields = Array.from(new Set([...metrics, 'pivotValues', 'dateRange'])).join(',');

  let scope;
  if (Array.isArray(body.campaignIds) && body.campaignIds.length) {
    const urns = body.campaignIds
      .map((id) => encodeURIComponent(`urn:li:sponsoredCampaign:${String(id).replace(/^urn:li:sponsoredCampaign:/, '')}`))
      .join(',');
    scope = `campaigns=List(${urns})`;
  } else {
    scope = `accounts=List(${encodeURIComponent(`urn:li:sponsoredAccount:${acctId}`)})`;
  }

  const url = `${BASE}/adAnalytics?q=analytics&pivot=${pivot}&timeGranularity=${granularity}` +
    `&dateRange=${dateRange}&${scope}&fields=${fields}`;
  const r = await liFetch(url);
  if (r.error) return json(r);

  // Computed efficiency fields the app's tool description promises.
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const rows = (r.data.elements || []).map((e) => {
    const imp = num(e.impressions), clk = num(e.clicks);
    const cost = num(e.costInLocalCurrency);
    const conv = num(e.externalWebsiteConversions);
    return {
      ...e,
      _ctr: imp > 0 ? +(clk / imp * 100).toFixed(3) : null,
      _cpm: imp > 0 ? +(cost / imp * 1000).toFixed(2) : null,
      _cpc: clk > 0 ? +(cost / clk).toFixed(2) : null,
      _cpa: conv > 0 ? +(cost / conv).toFixed(2) : null,
    };
  });
  return json({ data: rows, total: rows.length, pivot, dateRange: { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) } });
}
