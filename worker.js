/**
 * CMM Ads Intelligence — Cloudflare Worker proxy
 * ------------------------------------------------------------------
 * Handles the data sources the app sends:
 *   google_ads      { customerId, gaql, managerId? }
 *   meta_ads        { path, params, useAsync?, adAccountId? }
 *   meta_accounts   {}                    <-- the fix for "Unknown source"
 *   tiktok_ads      { path?, advertiserId?, ... }   (optional)
 *   linkedin_ads    { ... }                          (optional stub)
 *   meta_ad_library { searchTerms?, countries?, ... }   political & issue ads (public)
 *   fec             { endpoint, params? }               US campaign finance (official)
 *   gdelt_news      { query, mode?, timespan? }         global news monitoring (free)
 *   wiki_trends     { article, start, end }             Wikipedia attention (free)
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
 *   (optional) FEC_API_KEY       – free key from api.data.gov; falls back to DEMO_KEY
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
      if (source === 'meta_ad_library') return await metaAdLibrary(body, env);
      if (source === 'fec')             return await fecApi(body, env);
      if (source === 'gdelt_news')      return await gdeltNews(body);
      if (source === 'wiki_trends')     return await wikiTrends(body);
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
      model: body.model || 'claude-sonnet-4-6',
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
  const token = env.TIKTOK_ACCESS_TOKEN;
  const adv = body.advertiserId || env.TIKTOK_ADVERTISER_ID;
  if (!token) return json({ error: 'TikTok not configured (set TIKTOK_ACCESS_TOKEN)' });
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

  let url;
  if (action === 'report') {
    const dims = body.dimensions || ['campaign_id'];
    const params = {
      advertiser_id: adv,
      report_type: body.reportType || 'BASIC',
      data_level: dataLevel(dims),
      dimensions: dims,
      metrics: body.metrics || ['spend', 'impressions', 'clicks', 'ctr', 'cpc'],
      start_date: body.startDate,
      end_date: body.endDate,
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

/* ── LINKEDIN (optional stub) ─────────────────────────────────────── */
async function linkedinAds(body, env) {
  const token = env.LINKEDIN_ACCESS_TOKEN;
  if (!token) return json({ error: 'LinkedIn not configured (set LINKEDIN_ACCESS_TOKEN)' });
  // Fill in your exact LinkedIn Marketing API call here if you use it.
  return json({ error: 'LinkedIn handler not implemented — send me your query shape to complete it.' });
}

/* ── META AD LIBRARY: public political & social-issue ads ──────────── */
async function metaAdLibrary(body, env) {
  const token = env.META_ACCESS_TOKEN;
  if (!token) return json({ error: 'META_ACCESS_TOKEN secret is not set' });

  const q = new URLSearchParams();
  q.set('ad_type', body.adType || 'POLITICAL_AND_ISSUE_ADS');
  q.set('ad_reached_countries', JSON.stringify(body.countries || ['US']));
  q.set('ad_active_status', body.activeStatus || 'ALL');
  if (body.searchTerms) q.set('search_terms', body.searchTerms);
  if (body.pageIds) q.set('search_page_ids', JSON.stringify(body.pageIds));
  if (body.since) q.set('ad_delivery_date_min', body.since);
  if (body.until) q.set('ad_delivery_date_max', body.until);
  q.set('fields', body.fields || [
    'id', 'page_id', 'page_name', 'bylines', 'ad_creation_time',
    'ad_delivery_start_time', 'ad_delivery_stop_time', 'ad_creative_bodies',
    'ad_creative_link_titles', 'currency', 'spend', 'impressions',
    'demographic_distribution', 'delivery_by_region', 'publisher_platforms',
  ].join(','));
  q.set('limit', String(Math.min(Number(body.limit) || 25, 100)));
  q.set('access_token', token);

  const d = await (await fetch(`https://graph.facebook.com/${META_V}/ads_archive?` + q)).json();
  if (d.error) return json({ error: 'Meta Ad Library: ' + (d.error.message || 'Graph error') });

  // trim heavy creative/breakdown payloads so responses stay context-friendly
  const rows = (d.data || []).map((a) => {
    if (a.ad_creative_bodies) a.ad_creative_bodies = a.ad_creative_bodies.slice(0, 2).map((t) => String(t).slice(0, 300));
    if (a.demographic_distribution) a.demographic_distribution = a.demographic_distribution.slice(0, 24);
    if (a.delivery_by_region) a.delivery_by_region = a.delivery_by_region.slice(0, 15);
    return a;
  });
  return json({ data: rows, total: rows.length, truncated: !!(d.paging && d.paging.next) });
}

/* ── FEC: official US campaign-finance API (api.open.fec.gov) ──────── */
const FEC_ALLOWED = ['/candidates', '/candidate/', '/committees', '/committee/', '/schedules/', '/elections', '/filings', '/totals/', '/names/'];
async function fecApi(body, env) {
  let ep = String(body.endpoint || '');
  if (ep[0] !== '/') ep = '/' + ep;
  if (!FEC_ALLOWED.some((p) => ep.startsWith(p))) return json({ error: 'FEC endpoint not allowed: ' + ep });
  if (!ep.endsWith('/')) ep += '/';

  const q = new URLSearchParams();
  const params = body.params || {};
  for (const k in params) {
    const v = params[k];
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else q.set(k, String(v));
  }
  if (!q.get('per_page') || Number(q.get('per_page')) > 50) q.set('per_page', q.get('per_page') ? '50' : '20');
  q.set('api_key', env.FEC_API_KEY || 'DEMO_KEY');

  const r = await fetch('https://api.open.fec.gov/v1' + ep + '?' + q);
  const d = await r.json();
  if (!r.ok) return json({ error: 'FEC ' + r.status + ': ' + JSON.stringify(d).slice(0, 300) });
  return json({ data: d.results || d, total: (d.results || []).length, pagination: d.pagination });
}

/* ── GDELT: global news monitoring (free, no key) ──────────────────── */
async function gdeltNews(body) {
  const mode = body.mode || 'artlist';
  const q = new URLSearchParams({
    query: String(body.query || ''),
    mode,
    format: 'json',
    timespan: body.timespan || '7d',
  });
  if (mode === 'artlist') {
    q.set('maxrecords', String(Math.min(Number(body.maxrecords) || 25, 75)));
    q.set('sort', body.sort || 'hybridrel');
  }
  const r = await fetch('https://api.gdeltproject.org/api/v2/doc/doc?' + q, {
    headers: { 'User-Agent': 'CMM-Ads-Intelligence/1.0' },
  });
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch (_) { return json({ error: 'GDELT: ' + text.slice(0, 200) }); }
  if (mode === 'artlist') {
    const arts = (d.articles || []).map((a) => ({
      title: a.title, url: a.url, domain: a.domain,
      date: a.seendate, country: a.sourcecountry, lang: a.language,
    }));
    return json({ data: arts, total: arts.length });
  }
  return json({ data: d.timeline || d, total: (d.timeline && d.timeline.length) || 0 });
}

/* ── WIKIPEDIA: pageview attention trends (free, no key) ───────────── */
async function wikiTrends(body) {
  const art = encodeURIComponent(String(body.article || '').replace(/ /g, '_'));
  const proj = body.project || 'en.wikipedia';
  const start = String(body.start || '').replace(/-/g, '');
  const end = String(body.end || '').replace(/-/g, '');
  if (!art || !start || !end) return json({ error: 'article, start (YYYYMMDD) and end (YYYYMMDD) are required' });

  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${proj}/all-access/all-agents/${art}/daily/${start}/${end}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'CMM-Ads-Intelligence/1.0' } });
  const d = await r.json();
  if (!r.ok || (d.type && /errors/.test(String(d.type)))) {
    return json({ error: 'Wikimedia: ' + (d.title || 'article not found') + ' — check the exact Wikipedia article title' });
  }
  const rows = (d.items || []).map((i) => ({ date: i.timestamp.slice(0, 8), views: i.views }));
  return json({ data: rows, total: rows.length, article: body.article });
}
