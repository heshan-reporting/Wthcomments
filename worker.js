/**
 * CMM Ads Intelligence — Cloudflare Worker proxy
 * ------------------------------------------------------------------
 * Handles the data sources the app sends:
 *   google_ads      { customerId, gaql, managerId? }
 *   meta_ads        { path, params, useAsync?, adAccountId? }
 *   meta_accounts / google_accounts / tiktok_accounts / linkedin_accounts
 *                   {}   <-- account discovery for the client roster
 *   tiktok_ads      { path?, advertiserId?, ... }   (optional)
 *   linkedin_ads    { ... }                          (optional)
 *   pinterest_ads   { action?, accountId?, ... }     (optional)
 *   reddit_ads      { action?, accountId?, ... }     (optional)
 *   pinterest_accounts / reddit_accounts             (roster discovery)
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
 *   (optional) PINTEREST_ACCESS_TOKEN, PINTEREST_AD_ACCOUNT_ID,
 *              PINTEREST_CLIENT_ID, PINTEREST_CLIENT_SECRET, PINTEREST_REFRESH_TOKEN
 *   (optional) REDDIT_ACCESS_TOKEN, REDDIT_AD_ACCOUNT_ID,
 *              REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_REFRESH_TOKEN
 *              (Reddit access tokens expire after 24h — the refresh trio is
 *               what keeps Reddit working unattended)
 *   Platform tokens may also arrive per-request as body.accessToken (set in the
 *   app's Configuration) — worker secrets take precedence when both exist.
 * ------------------------------------------------------------------
 */

const WORKER_VERSION = '3.1.0';   // bump when sources/behaviour change; the app's Connection Doctor compares it

/* Optional infrastructure (all feature-gated — the worker runs fine without):
   ADS_KV (KV namespace binding)  – enables the query cache, daily spend
     history snapshots, monitoring baselines, and the mutation audit log.
     Create: Cloudflare dash → Storage & Databases → KV → create namespace,
     then bind it to this worker as "ADS_KV".
   CACHE_TTL            – query cache lifetime in seconds (default 900).
   ALLOW_MUTATIONS      – set to "true" to enable pause/enable/budget changes.
   MUTATION_MAX_BUDGET  – optional cap on any budget amount set via mutate.
   CLIENTS_JSON entries may carry any platform ids plus "monthlyBudget"
   (account currency) to enable budget-exhaustion forecasts:
   [{"name":"Acme","meta":{"act":"act_1"},"google":{"cid":"123"},
     "tiktok":{"adv":"7..."},"linkedin":{"acct":"5..."},
     "pinterest":{"acct":"5..."},"reddit":{"acct":"t2_..."},
     "monthlyBudget":15000}] */

/* Sources served from the cache when the caller opts in (cacheOk:true). */
const CACHE_SOURCES = ['google_ads','meta_ads','tiktok_ads','linkedin_ads','pinterest_ads','reddit_ads',
  'meta_accounts','google_accounts','tiktok_accounts','linkedin_accounts','pinterest_accounts','reddit_accounts'];

async function cacheKey(body) {
  const c = { ...body };
  delete c.accessToken; delete c.refreshToken; delete c.cacheOk; delete c.fresh;   // never key on secrets
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(c)));
  return 'q:' + [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
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
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── WhatsApp webhook (Meta calls this; no X-Auth-Token) ──
    const url = new URL(request.url);
    if (/\/whatsapp\/?$/.test(url.pathname)) {
      if (request.method === 'GET') {
        // Meta's one-time verification handshake
        const p = url.searchParams;
        if (p.get('hub.mode') === 'subscribe' && p.get('hub.verify_token') === env.WHATSAPP_VERIFY_TOKEN) {
          return new Response(p.get('hub.challenge') || '', { status: 200 });
        }
        return new Response('Forbidden', { status: 403 });
      }
      if (request.method === 'POST') return await waInbound(request, env, ctx);
    }

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
      // ── read-through query cache (opt-in per request via cacheOk) ──
      const cacheable = env.ADS_KV && body.cacheOk && !body.fresh && CACHE_SOURCES.includes(source);
      let ckey = null;
      if (cacheable) {
        ckey = await cacheKey(body);
        const hit = await env.ADS_KV.get(ckey);
        if (hit) return new Response(hit, { headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' } });
      }
      const res = await routeSource(source, body, env);
      if (cacheable && res && res.status === 200) {
        const txt = await res.clone().text();
        let ok = false; try { ok = !JSON.parse(txt).error; } catch (_) {}
        if (ok) await env.ADS_KV.put(ckey, txt, { expirationTtl: Math.max(60, Number(env.CACHE_TTL || 900)) });
      }
      return res;
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 200);
    }
  },

  // ── Cron Trigger: snapshot → monitors → WhatsApp digest ──
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (env.ADS_KV) {
        try { await spendSnapshot(env); } catch (_) {}
        try {
          const m = await runMonitors(env);
          if (m.alerts && m.alerts.length && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID) {
            const to = waNums(env.WHATSAPP_RECIPIENTS);
            const lines = m.alerts.slice(0, 10).map((a) => '• ' + a.msg).join('\n');
            await Promise.all(to.map((n) =>
              waSendTemplate(env, n, ['⚠ Alerts · ' + new Date().toISOString().slice(0, 10),
                m.alerts.length + ' issue(s) need attention', lines]).catch(() => null)));
          }
        } catch (_) {}
      }
      await waRunDigest(env, Number(env.WHATSAPP_DIGEST_DAYS || 1), false);
    })());
  },
};

async function routeSource(source, body, env) {
  if (source === 'health')        return await health(body, env);
  if (source === 'claude')        return await claude(body, env);
  if (source === 'google_ads')    return await googleAds(body, env);
  if (source === 'meta_ads')      return await metaAds(body, env);
  if (source === 'meta_accounts') return await metaAccounts(env);
  if (source === 'google_accounts')   return await googleAccounts(env);
  if (source === 'tiktok_accounts')   return await tiktokAccounts(body, env);
  if (source === 'linkedin_accounts') return await linkedinAccounts(body, env);
  if (source === 'pinterest_accounts') return await pinterestAccounts(body, env);
  if (source === 'reddit_accounts')    return await redditAccounts(body, env);
  if (source === 'tiktok_ads')    return await tiktokAds(body, env);
  if (source === 'linkedin_ads')  return await linkedinAds(body, env);
  if (source === 'pinterest_ads') return await pinterestAds(body, env);
  if (source === 'reddit_ads')    return await redditAds(body, env);
  if (source === 'history')       return await historyGet(body, env);
  if (source === 'snapshot')      return json(await spendSnapshot(env, true));
  if (source === 'monitor')       return json(await runMonitors(env));
  if (source === 'mutate')        return await mutate(body, env);
  if (source === 'audit_log')     return await auditLog(body, env);
  if (source === 'whatsapp_test') return await waTest(body, env);
  if (source === 'whatsapp_digest') return json(await waRunDigest(env, body.days || 1, !!body.dryRun));
  return json({ error: 'Unknown source: ' + source }, 400);
}

/* ── HEALTH: the app's Connection Doctor calls this ─────────────────
   Reports the worker version, which secrets exist (booleans only — never
   values), and with body.live=true runs one cheap authenticated probe per
   platform and returns a parsed diagnosis with the exact fix. */
async function health(body, env) {
  const has = (k) => !!env[k];
  const secrets = {
    anthropic: !!(env.ANTHROPIC_API_KEY || env.CLAUDE_KEY || env.CLAUDE_API_KEY || env.ANTHROPIC_KEY),
    auth_secret: has('AUTH_SECRET'),
    meta: { access_token: has('META_ACCESS_TOKEN') },
    google: {
      developer_token: has('GOOGLE_ADS_DEVELOPER_TOKEN'), client_id: has('GOOGLE_ADS_CLIENT_ID'),
      client_secret: has('GOOGLE_ADS_CLIENT_SECRET'), refresh_token: has('GOOGLE_ADS_REFRESH_TOKEN'),
      login_customer_id: has('GOOGLE_ADS_LOGIN_CUSTOMER_ID'),
    },
    tiktok: { access_token: has('TIKTOK_ACCESS_TOKEN'), app_id: has('TIKTOK_APP_ID'), app_secret: has('TIKTOK_APP_SECRET') },
    linkedin: { access_token: has('LINKEDIN_ACCESS_TOKEN'),
      refresh: has('LINKEDIN_REFRESH_TOKEN') && has('LINKEDIN_CLIENT_ID') && has('LINKEDIN_CLIENT_SECRET') },
    pinterest: { access_token: has('PINTEREST_ACCESS_TOKEN'),
      refresh: has('PINTEREST_REFRESH_TOKEN') && has('PINTEREST_CLIENT_ID') && has('PINTEREST_CLIENT_SECRET') },
    reddit: { access_token: has('REDDIT_ACCESS_TOKEN'),
      refresh: has('REDDIT_REFRESH_TOKEN') && has('REDDIT_CLIENT_ID') && has('REDDIT_CLIENT_SECRET') },
    whatsapp: { token: has('WHATSAPP_TOKEN'), phone_id: has('WHATSAPP_PHONE_ID') },
  };
  const infra = {
    kv: !!env.ADS_KV,
    mutations_enabled: String(env.ALLOW_MUTATIONS).toLowerCase() === 'true',
    cache_ttl_seconds: Math.max(60, Number(env.CACHE_TTL || 900)),
  };
  if (!body.live) return json({ version: WORKER_VERSION, secrets, infra });

  // Live probes — each is the cheapest authenticated call the platform has.
  // A probe that can't run because nothing is configured reports 'skip'.
  const deadline = (p, ms) => Promise.race([p, sleep(ms).then(() => ({ ok: false, error: 'Timed out after ' + ms / 1000 + 's' }))]);
  const probe = async (name, fn) => {
    try { return { name, ...(await deadline(fn(), 9000)) }; }
    catch (e) { return { name, ok: false, error: String((e && e.message) || e) }; }
  };
  const passthru = (tok) => (tok ? { accessToken: tok } : {});

  const checks = await Promise.all([
    probe('meta', async () => {
      if (!env.META_ACCESS_TOKEN) return { skip: 'META_ACCESS_TOKEN secret is not set' };
      const d = await (await fetch(`https://graph.facebook.com/${META_V}/me/adaccounts?fields=name&limit=1&access_token=${encodeURIComponent(env.META_ACCESS_TOKEN)}`)).json();
      if (d.error) return { ok: false, error: 'Facebook: ' + d.error.message, fix: /expired|invalid/i.test(d.error.message) ? 'Generate a new system-user token (never-expiring) and update META_ACCESS_TOKEN' : 'Check the token has ads_read on the right Business Manager assets' };
      return { ok: true, detail: (d.data && d.data.length ? d.data.length + '+ ad account(s) reachable' : 'token valid, no ad accounts visible') };
    }),
    probe('google', async () => {
      if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) return { skip: 'GOOGLE_ADS_DEVELOPER_TOKEN secret is not set' };
      const tok = await googleAccessToken(env);
      if (tok.error) return { ok: false, error: tok.error, fix: /invalid_grant/i.test(tok.error) ? 'The refresh token was revoked — mint a new one with the OAuth flow in the Setup guide and update GOOGLE_ADS_REFRESH_TOKEN' : 'Check GOOGLE_ADS_CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN' };
      const r = await fetch(`https://googleads.googleapis.com/${GOOGLE_V}/customers:listAccessibleCustomers`,
        { headers: { Authorization: 'Bearer ' + tok.token, 'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN } });
      const t = await r.text();
      if (!r.ok) return { ok: false, error: googleErr(r.status, t), fix: googleFix(t) };
      let n = 0; try { n = (JSON.parse(t).resourceNames || []).length; } catch (_) {}
      const mccNote = env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? '' : ' · no GOOGLE_ADS_LOGIN_CUSTOMER_ID set — client accounts under an MCC will 403 without it';
      return { ok: true, detail: n + ' accessible customer(s)' + mccNote };
    }),
    probe('tiktok', async () => {
      const tk = env.TIKTOK_ACCESS_TOKEN;
      if (!tk) return { skip: 'TIKTOK_ACCESS_TOKEN secret is not set' };
      const d = await (await fetch('https://business-api.tiktok.com/open_api/v1.3/user/info/', { headers: { 'Access-Token': tk } })).json();
      if (d.code !== 0) return { ok: false, error: 'TikTok ' + d.code + ': ' + (d.message || 'error'), fix: tiktokFix(d.code) };
      return { ok: true, detail: 'token valid' + (env.TIKTOK_APP_ID ? '' : ' · set TIKTOK_APP_ID/APP_SECRET to enable advertiser discovery') };
    }),
    probe('linkedin', async () => {
      if (!env.LINKEDIN_ACCESS_TOKEN && !env.LINKEDIN_REFRESH_TOKEN) return { skip: 'No LINKEDIN_ACCESS_TOKEN or refresh trio set' };
      const r = await linkedinAds({ action: 'accounts', count: 1 }, env);
      const d = await r.json();
      if (d.error) return { ok: false, error: d.error, fix: /401/.test(d.error) ? 'Access token expired — add LINKEDIN_REFRESH_TOKEN + LINKEDIN_CLIENT_ID/SECRET so it auto-renews, or paste a fresh token' : (/403/.test(d.error) ? 'The token is missing the r_ads scope, or the app lacks Marketing API access' : 'Check the token and LinkedIn-Version') };
      return { ok: true, detail: (d.total || 0) + ' ad account(s) reachable' };
    }),
    probe('pinterest', async () => {
      if (!env.PINTEREST_ACCESS_TOKEN && !env.PINTEREST_REFRESH_TOKEN) return { skip: 'No Pinterest token secrets set' };
      const r = await pinterestAds({ action: 'accounts', ...passthru(null) }, env);
      const d = await r.json();
      if (d.error) return { ok: false, error: d.error, fix: /401/.test(d.error) ? 'Token expired — set PINTEREST_REFRESH_TOKEN + CLIENT_ID/SECRET for auto-renew' : 'Check the token has the ads:read scope' };
      return { ok: true, detail: (d.total || 0) + ' ad account(s) reachable' };
    }),
    probe('reddit', async () => {
      if (!env.REDDIT_ACCESS_TOKEN && !env.REDDIT_REFRESH_TOKEN) return { skip: 'No Reddit token secrets set' };
      const r = await redditAds({ action: 'accounts' }, env);
      const d = await r.json();
      if (d.error) return { ok: false, error: d.error, fix: /refresh failed|401/.test(d.error) ? 'Reddit tokens expire daily — set REDDIT_REFRESH_TOKEN + REDDIT_CLIENT_ID/SECRET (the adsread scope)' : 'Check the app credentials' };
      return { ok: true, detail: (d.total || 0) + ' ad account(s) reachable' };
    }),
    probe('anthropic', async () => {
      const key = env.ANTHROPIC_API_KEY || env.CLAUDE_KEY || env.CLAUDE_API_KEY || env.ANTHROPIC_KEY;
      if (!key) return { skip: 'ANTHROPIC_API_KEY secret is not set (the app can also use a browser-side key)' };
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      });
      if (r.status === 401) return { ok: false, error: 'API key rejected', fix: 'Replace the ANTHROPIC_API_KEY secret' };
      return { ok: true, detail: 'API key accepted' };
    }),
  ]);
  return json({ version: WORKER_VERSION, secrets, infra, checks });
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERSISTENCE & MONITORING (needs the ADS_KV binding)
   ---------------------------------------------------------------------------
   spendSnapshot  – stores yesterday's account-level spend per client per
                    platform under hist:<date>; runs from the cron trigger
                    and dedupes, so multiple crons a day are safe.
   historyGet     – returns stored snapshots (the app's baselines + trends).
   runMonitors    – compares the latest snapshot against the trailing week:
                    spend spikes, collapses, accounts that stopped spending,
                    and monthly-budget exhaustion forecasts (when a client in
                    CLIENTS_JSON declares monthlyBudget). Alerts go out over
                    WhatsApp from the cron.
   ═════════════════════════════════════════════════════════════════════════ */

async function spendSnapshot(env, force) {
  if (!env.ADS_KV) return { error: 'ADS_KV namespace is not bound — create a KV namespace and bind it as ADS_KV' };
  const y = new Date(); y.setUTCHours(0, 0, 0, 0); y.setUTCDate(y.getUTCDate() - 1);
  const date = y.toISOString().slice(0, 10);
  if (!force && await env.ADS_KV.get('hist:' + date)) return { skipped: 'already stored', date };

  const clients = await waClients(env);
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const rows = [];
  const push = (c, platform, spend, imp, clk, cur) =>
    rows.push({ client: c.name, platform, spend: +num(spend).toFixed(2),
      impressions: Math.round(num(imp)), clicks: Math.round(num(clk)), currency: cur || c.currency || 'USD' });

  await Promise.all(clients.map(async (c) => {
    const jobs = [];
    if (c.meta && c.meta.act) jobs.push((async () => {
      const j = await (await metaAds({ adAccountId: c.meta.act, path: '/insights',
        params: { level: 'account', fields: 'spend,impressions,clicks,account_currency',
          time_range: JSON.stringify({ since: date, until: date }) } }, env)).json();
      const r = (j.data || [])[0] || {};
      if (!j.error) push(c, 'meta', r.spend, r.impressions, r.clicks, r.account_currency);
    })().catch(() => {}));
    if (c.google && c.google.cid) jobs.push((async () => {
      const j = await (await googleAds({ customerId: c.google.cid, managerId: c.google.mgr,
        gaql: `SELECT customer.currency_code, metrics.cost_micros, metrics.impressions, metrics.clicks FROM customer WHERE segments.date = '${date}'` }, env)).json();
      let s = 0, i = 0, k = 0, cur = null;
      (j.results || []).forEach((x) => { s += num(x.metrics && x.metrics.costMicros) / 1e6;
        i += num(x.metrics && x.metrics.impressions); k += num(x.metrics && x.metrics.clicks);
        cur = (x.customer && x.customer.currencyCode) || cur; });
      if (!j.error) push(c, 'google', s, i, k, cur);
    })().catch(() => {}));
    if (c.tiktok && c.tiktok.adv) jobs.push((async () => {
      const j = await (await tiktokAds({ advertiserId: c.tiktok.adv, action: 'report',
        dimensions: ['advertiser_id'], metrics: ['spend', 'impressions', 'clicks'],
        startDate: date, endDate: date }, env)).json();
      const m = ((j.data || [])[0] || {}).metrics || (j.data || [])[0] || {};
      if (!j.error) push(c, 'tiktok', m.spend, m.impressions, m.clicks, c.tiktok.cur);
    })().catch(() => {}));
    if (c.linkedin && c.linkedin.acct) jobs.push((async () => {
      const j = await (await linkedinAds({ accountId: c.linkedin.acct, action: 'analytics', pivot: 'ACCOUNT',
        startDate: date, endDate: date }, env)).json();
      let s = 0, i = 0, k = 0;
      (j.data || []).forEach((x) => { s += num(x.costInLocalCurrency); i += num(x.impressions); k += num(x.clicks); });
      if (!j.error) push(c, 'linkedin', s, i, k, c.linkedin.cur);
    })().catch(() => {}));
    if (c.pinterest && c.pinterest.acct) jobs.push((async () => {
      const j = await (await pinterestAds({ accountId: c.pinterest.acct, action: 'analytics',
        startDate: date, endDate: date }, env)).json();
      const r = (j.data || [])[0] || {};
      if (!j.error) push(c, 'pinterest', r.SPEND, r.IMPRESSION_2, r.CLICKTHROUGH_2, c.pinterest.cur);
    })().catch(() => {}));
    if (c.reddit && c.reddit.acct) jobs.push((async () => {
      const j = await (await redditAds({ accountId: c.reddit.acct, action: 'report',
        breakdowns: ['campaign_id'], fields: ['spend', 'impressions', 'clicks'],
        startDate: date, endDate: date }, env)).json();
      let s = 0, i = 0, k = 0;
      (j.data || []).forEach((x) => { s += num(x.spend); i += num(x.impressions); k += num(x.clicks); });
      if (!j.error) push(c, 'reddit', s, i, k, c.reddit.cur);
    })().catch(() => {}));
    await Promise.all(jobs);
  }));

  const snap = { date, rows, created: Date.now() };
  await env.ADS_KV.put('hist:' + date, JSON.stringify(snap), { expirationTtl: 60 * 60 * 24 * 400 });
  return { stored: true, date, rows: rows.length };
}

async function getSnaps(env, days) {
  const out = await Promise.all(Array.from({ length: days }, (_, i) => {
    const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - 1 - i);
    return env.ADS_KV.get('hist:' + d.toISOString().slice(0, 10))
      .then((v) => { try { return v ? JSON.parse(v) : null; } catch (_) { return null; } });
  }));
  return out.filter(Boolean).reverse();   // oldest → newest
}

async function historyGet(body, env) {
  if (!env.ADS_KV) return json({ error: 'ADS_KV namespace is not bound — create a KV namespace and bind it as ADS_KV to enable spend history' });
  const snapshots = await getSnaps(env, Math.min(Number(body.days) || 30, 120));
  return json({ snapshots, total: snapshots.length });
}

async function runMonitors(env) {
  if (!env.ADS_KV) return { error: 'ADS_KV not bound — monitors need spend history', alerts: [] };
  const snaps = await getSnaps(env, 8);
  if (!snaps.length) return { alerts: [], note: 'no snapshots yet — run source:"snapshot" once, or wait for the cron' };
  const latest = snaps[snaps.length - 1];
  const money = (n, cur) => (cur || '$') + ' ' + (Math.round(Number(n) * 100) / 100).toLocaleString('en-US');

  const key = (r) => r.client + '·' + r.platform;
  const base = {};
  snaps.slice(0, -1).forEach((s) => (s.rows || []).forEach((r) => { (base[key(r)] = base[key(r)] || []).push(r.spend); }));

  const alerts = [];
  (latest.rows || []).forEach((r) => {
    const b = base[key(r)] || [];
    if (b.length < 3) return;                                    // not enough baseline
    const avg = b.reduce((a, x) => a + x, 0) / b.length;
    if (avg < 5) return;                                         // too small to judge
    const ratio = r.spend / avg;
    const who = r.client + ' · ' + r.platform;
    if (r.spend === 0) alerts.push({ sev: 'high', type: 'stopped', client: r.client, platform: r.platform,
      msg: who + ': spent NOTHING on ' + latest.date + ' vs ' + money(avg, r.currency) + '/day average — check billing, budgets and disapprovals' });
    else if (ratio >= 1.8) alerts.push({ sev: 'high', type: 'spike', client: r.client, platform: r.platform,
      msg: who + ': spend spiked to ' + money(r.spend, r.currency) + ' (' + latest.date + ') vs ' + money(avg, r.currency) + '/day average (×' + ratio.toFixed(1) + ')' });
    else if (ratio <= 0.35) alerts.push({ sev: 'med', type: 'collapse', client: r.client, platform: r.platform,
      msg: who + ': spend collapsed to ' + money(r.spend, r.currency) + ' vs ' + money(avg, r.currency) + '/day average' });
  });

  /* Budget-exhaustion forecasts — only for clients that declare monthlyBudget. */
  const clients = await waClients(env);
  const budgeted = clients.filter((c) => Number(c.monthlyBudget) > 0);
  if (budgeted.length) {
    const now = new Date();
    const monthKey = now.toISOString().slice(0, 7);
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const monthSnaps = (await getSnaps(env, 32)).filter((s) => s.date.slice(0, 7) === monthKey);
    budgeted.forEach((c) => {
      const spent = monthSnaps.reduce((s, sn) => s + (sn.rows || []).filter((r) => r.client === c.name)
        .reduce((a, r) => a + r.spend, 0), 0);
      const elapsed = monthSnaps.length;
      if (!elapsed || spent <= 0) return;
      const rate = spent / elapsed;
      const projected = spent + rate * (daysInMonth - elapsed);
      const cur = (c.currency || (monthSnaps[0] && (monthSnaps[0].rows.find((r) => r.client === c.name) || {}).currency)) || '';
      if (projected > c.monthlyBudget) {
        const exhaustIn = Math.max(0, Math.floor((c.monthlyBudget - spent) / rate));
        const exhaustDate = new Date(now.getTime() + exhaustIn * 864e5).toISOString().slice(0, 10);
        alerts.push({ sev: projected > c.monthlyBudget * 1.15 ? 'high' : 'med', type: 'budget', client: c.name,
          msg: c.name + ': on pace to spend ' + money(projected, cur) + ' of a ' + money(c.monthlyBudget, cur) +
            ' monthly budget (' + Math.round(projected / c.monthlyBudget * 100) + '%) — exhausts ~' + exhaustDate });
      } else if (projected < c.monthlyBudget * 0.8) {
        alerts.push({ sev: 'low', type: 'budget', client: c.name,
          msg: c.name + ': projected ' + money(projected, cur) + ' vs ' + money(c.monthlyBudget, cur) +
            ' monthly budget (' + Math.round(projected / c.monthlyBudget * 100) + '%) — underspending' });
      }
    });
  }

  const order = { high: 0, med: 1, low: 2 };
  alerts.sort((a, b) => order[a.sev] - order[b.sev]);
  return { date: latest.date, alerts, baseline_days: snaps.length - 1 };
}

/* ═══════════════════════════════════════════════════════════════════════════
   MUTATIONS — pause / enable / daily budget, behind two locks:
   1. ALLOW_MUTATIONS secret must be "true" (default: everything read-only)
   2. the app shows an approval card and only calls after a human clicks
   Every attempt is written to the KV audit log when ADS_KV is bound.
   ═════════════════════════════════════════════════════════════════════════ */

async function mutate(body, env) {
  if (String(env.ALLOW_MUTATIONS).toLowerCase() !== 'true')
    return json({ error: 'Mutations are disabled on this worker (read-only mode). Set the ALLOW_MUTATIONS secret to "true" to enable pause/enable/budget changes.' });
  const { platform, action, campaignId } = body;
  if (!platform || !action || !campaignId) return json({ error: 'platform, action and campaignId are required' });
  const audit = async (ok, detail) => {
    if (!env.ADS_KV) return;
    const entry = { ts: Date.now(), platform, action, campaignId: String(campaignId),
      campaignName: body.campaignName || null, client: body.client || null,
      amount: body.amount != null ? Number(body.amount) : null, ok, detail };
    await env.ADS_KV.put('audit:' + String(entry.ts).padStart(14, '0') + ':' + Math.random().toString(36).slice(2, 6),
      JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 180 }).catch(() => {});
  };
  const amount = Number(body.amount);
  if (action === 'budget') {
    if (!(amount > 0)) return json({ error: 'budget action needs a positive "amount" — the new DAILY budget in the account currency' });
    const cap = Number(env.MUTATION_MAX_BUDGET || 0);
    if (cap && amount > cap) {
      await audit(false, 'refused: amount ' + amount + ' exceeds MUTATION_MAX_BUDGET (' + cap + ')');
      return json({ error: 'Amount ' + amount + ' exceeds MUTATION_MAX_BUDGET (' + cap + ') set on the worker' });
    }
  }
  let result;
  try {
    if (platform === 'meta')          result = await metaMutate(body, env, amount);
    else if (platform === 'google')   result = await googleMutate(body, env, amount);
    else if (platform === 'tiktok')   result = await tiktokMutate(body, env, amount);
    else if (platform === 'linkedin') result = await linkedinMutate(body, env);
    else if (platform === 'pinterest') result = await pinterestMutate(body, env, amount);
    else if (platform === 'reddit')   result = await redditMutate(body, env);
    else result = { error: 'Unknown platform: ' + platform };
  } catch (e) { result = { error: String((e && e.message) || e) }; }

  await audit(!result.error, result.error || 'applied');
  return json(result.error ? { error: result.error } : { ok: true, ...result });
}

async function metaMutate(body, env, amount) {
  const token = env.META_ACCESS_TOKEN;
  if (!token) return { error: 'META_ACCESS_TOKEN not set' };
  const p = new URLSearchParams({ access_token: token });
  if (body.action === 'pause') p.set('status', 'PAUSED');
  else if (body.action === 'enable') p.set('status', 'ACTIVE');
  else if (body.action === 'budget') p.set('daily_budget', String(Math.round(amount * 100)));   // cents
  else return { error: 'Unsupported action for Meta: ' + body.action };
  const d = await (await fetch(`https://graph.facebook.com/${META_V}/${body.campaignId}`, { method: 'POST', body: p })).json();
  if (d.error) return { error: 'Facebook: ' + d.error.message };
  return { platform: 'meta', action: body.action, campaignId: String(body.campaignId), applied: true };
}

async function googleMutate(body, env, amount) {
  const dev = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!dev) return { error: 'GOOGLE_ADS_DEVELOPER_TOKEN not set' };
  const tok = await googleAccessToken(env);
  if (tok.error) return { error: tok.error };
  const cid = String(body.customerId || env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  if (!cid) return { error: 'customerId is required for Google mutations' };
  const headers = { Authorization: 'Bearer ' + tok.token, 'developer-token': dev, 'Content-Type': 'application/json' };
  const mgr = String(body.managerId || env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
  if (mgr && mgr !== cid) headers['login-customer-id'] = mgr;

  if (body.action === 'pause' || body.action === 'enable') {
    const op = { update: { resourceName: `customers/${cid}/campaigns/${body.campaignId}`,
      status: body.action === 'pause' ? 'PAUSED' : 'ENABLED' }, updateMask: 'status' };
    const r = await fetch(`https://googleads.googleapis.com/${GOOGLE_V}/customers/${cid}/campaigns:mutate`,
      { method: 'POST', headers, body: JSON.stringify({ operations: [op] }) });
    const t = await r.text();
    if (!r.ok) return { error: googleErr(r.status, t) };
    return { platform: 'google', action: body.action, campaignId: String(body.campaignId), applied: true };
  }
  if (body.action === 'budget') {
    // Budgets live on their own resource — find the campaign's, then mutate it.
    const rr = await fetch(`https://googleads.googleapis.com/${GOOGLE_V}/customers/${cid}/googleAds:searchStream`,
      { method: 'POST', headers, body: JSON.stringify({ query: `SELECT campaign.campaign_budget FROM campaign WHERE campaign.id = ${Number(body.campaignId)}` }) });
    const tt = await rr.text();
    if (!rr.ok) return { error: googleErr(rr.status, tt) };
    let bres = null;
    try { const b = JSON.parse(tt);
      (Array.isArray(b) ? b : [b]).forEach((x) => (x.results || []).forEach((y) => { bres = y.campaign && y.campaign.campaignBudget; })); } catch (_) {}
    if (!bres) return { error: 'Could not find the budget resource for campaign ' + body.campaignId };
    const op = { update: { resourceName: bres, amountMicros: String(Math.round(amount * 1e6)) }, updateMask: 'amount_micros' };
    const r = await fetch(`https://googleads.googleapis.com/${GOOGLE_V}/customers/${cid}/campaignBudgets:mutate`,
      { method: 'POST', headers, body: JSON.stringify({ operations: [op] }) });
    const t = await r.text();
    if (!r.ok) return { error: googleErr(r.status, t) };
    return { platform: 'google', action: 'budget', campaignId: String(body.campaignId), amount, applied: true,
      note: 'If this budget is shared, every campaign using it changes too' };
  }
  return { error: 'Unsupported action for Google: ' + body.action };
}

async function tiktokMutate(body, env, amount) {
  const token = env.TIKTOK_ACCESS_TOKEN || body.accessToken;
  const adv = body.advertiserId || env.TIKTOK_ADVERTISER_ID;
  if (!token) return { error: 'TikTok not configured (TIKTOK_ACCESS_TOKEN)' };
  if (!adv) return { error: 'advertiserId is required for TikTok mutations' };
  const base = 'https://business-api.tiktok.com/open_api/v1.3';
  const post = async (ep, payload) => (await fetch(base + ep, { method: 'POST',
    headers: { 'Access-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })).json();
  let d;
  if (body.action === 'pause' || body.action === 'enable')
    d = await post('/campaign/status/update/', { advertiser_id: adv, campaign_ids: [String(body.campaignId)],
      operation: body.action === 'pause' ? 'DISABLE' : 'ENABLE' });
  else if (body.action === 'budget')
    d = await post('/campaign/update/', { advertiser_id: adv, campaign_id: String(body.campaignId), budget: amount });
  else return { error: 'Unsupported action for TikTok: ' + body.action };
  if (d.code !== 0) { const fx = tiktokFix(d.code);
    return { error: 'TikTok ' + d.code + ': ' + (d.message || 'error') + (fx ? ' — FIX: ' + fx : '') }; }
  return { platform: 'tiktok', action: body.action, campaignId: String(body.campaignId), applied: true };
}

async function linkedinMutate(body, env) {
  const token = env.LINKEDIN_ACCESS_TOKEN || body.accessToken;
  if (!token) return { error: 'LinkedIn mutations need LINKEDIN_ACCESS_TOKEN (run the Connection Doctor if it expired)' };
  const acct = String(body.accountId || env.LINKEDIN_AD_ACCOUNT_ID || '').replace(/^urn:li:sponsoredAccount:/, '');
  if (!acct) return { error: 'accountId is required for LinkedIn mutations' };
  if (body.action !== 'pause' && body.action !== 'enable')
    return { error: 'Only pause/enable are supported for LinkedIn (budget changes are not wired yet)' };
  const r = await fetch(`https://api.linkedin.com/rest/adAccounts/${acct}/adCampaigns/${String(body.campaignId).replace(/^urn:li:sponsoredCampaign:/, '')}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'LinkedIn-Version': env.LINKEDIN_VERSION || '202506',
      'X-Restli-Protocol-Version': '2.0.0', 'X-RestLi-Method': 'PARTIAL_UPDATE', 'Content-Type': 'application/json' },
    body: JSON.stringify({ patch: { $set: { status: body.action === 'pause' ? 'PAUSED' : 'ACTIVE' } } }),
  });
  if (!r.ok) { const t = await r.text(); return { error: 'LinkedIn ' + r.status + ': ' + t.slice(0, 200) }; }
  return { platform: 'linkedin', action: body.action, campaignId: String(body.campaignId), applied: true };
}

async function pinterestMutate(body, env, amount) {
  const token = env.PINTEREST_ACCESS_TOKEN || body.accessToken;
  if (!token) return { error: 'Pinterest not configured (PINTEREST_ACCESS_TOKEN)' };
  const acct = String(body.accountId || env.PINTEREST_AD_ACCOUNT_ID || '').trim();
  if (!acct) return { error: 'accountId is required for Pinterest mutations' };
  const patch = { id: String(body.campaignId) };
  if (body.action === 'pause') patch.status = 'PAUSED';
  else if (body.action === 'enable') patch.status = 'ACTIVE';
  else if (body.action === 'budget') patch.daily_spend_cap = Math.round(amount * 1e6);   // micro-currency
  else return { error: 'Unsupported action for Pinterest: ' + body.action };
  const r = await fetch(`https://api.pinterest.com/v5/ad_accounts/${acct}/campaigns`, {
    method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify([patch]),
  });
  const t = await r.text();
  if (!r.ok) return { error: 'Pinterest ' + r.status + ': ' + t.slice(0, 200) };
  return { platform: 'pinterest', action: body.action, campaignId: String(body.campaignId), applied: true };
}

async function redditMutate(body, env) {
  let token = env.REDDIT_ACCESS_TOKEN || body.accessToken;
  if (!token && env.REDDIT_REFRESH_TOKEN && env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    const d = await (await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'cmm-ads-intelligence/1.0',
        Authorization: 'Basic ' + btoa(env.REDDIT_CLIENT_ID + ':' + env.REDDIT_CLIENT_SECRET) },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.REDDIT_REFRESH_TOKEN }),
    })).json().catch(() => null);
    if (d && d.access_token) token = d.access_token;
  }
  if (!token) return { error: 'Reddit not configured' };
  const acct = String(body.accountId || env.REDDIT_AD_ACCOUNT_ID || '').trim();
  if (!acct) return { error: 'accountId is required for Reddit mutations' };
  if (body.action !== 'pause' && body.action !== 'enable')
    return { error: 'Only pause/enable are supported for Reddit (budgets live on ad groups, not campaigns)' };
  const r = await fetch(`https://ads-api.reddit.com/api/v3/ad_accounts/${acct}/campaigns/${body.campaignId}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'cmm-ads-intelligence/1.0' },
    body: JSON.stringify({ data: { configured_status: body.action === 'pause' ? 'PAUSED' : 'ACTIVE' } }),
  });
  const t = await r.text();
  if (!r.ok) return { error: 'Reddit ' + r.status + ': ' + t.slice(0, 200) };
  return { platform: 'reddit', action: body.action, campaignId: String(body.campaignId), applied: true };
}

async function auditLog(body, env) {
  if (!env.ADS_KV) return json({ error: 'ADS_KV not bound — there is no audit log without it' });
  const l = await env.ADS_KV.list({ prefix: 'audit:', limit: 200 });
  const entries = (await Promise.all((l.keys || []).map((k) =>
    env.ADS_KV.get(k.name).then((v) => { try { return JSON.parse(v); } catch (_) { return null; } }))))
    .filter(Boolean).sort((a, b) => b.ts - a.ts).slice(0, Math.min(Number(body.limit) || 50, 200));
  return json({ entries, total: entries.length });
}

/* Google Ads errors arrive as deep JSON — surface the real message + code. */
function googleErr(status, text) {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0].error : j.error;
    const det = e && e.details && e.details[0] && e.details[0].errors && e.details[0].errors[0];
    const code = det && det.errorCode ? Object.values(det.errorCode)[0] : '';
    return 'Google ' + status + (code ? ' [' + code + ']' : '') + ': ' + ((det && det.message) || (e && e.message) || text.slice(0, 200));
  } catch (_) { return 'Google ' + status + ': ' + text.slice(0, 300); }
}
function googleFix(text) {
  if (/DEVELOPER_TOKEN_NOT_APPROVED/.test(text)) return 'Your developer token only works on test accounts — apply for Basic access in Google Ads → API Center';
  if (/USER_PERMISSION_DENIED/.test(text)) return 'The OAuth user cannot see this account — set GOOGLE_ADS_LOGIN_CUSTOMER_ID to your MCC id (no dashes) and make sure the MCC links to this client account';
  if (/CUSTOMER_NOT_FOUND|INVALID_CUSTOMER_ID/.test(text)) return 'The customer id is wrong — use the 10-digit id without dashes';
  if (/DEACTIVATED|CANCELED/i.test(text)) return 'That Google Ads account is deactivated/cancelled';
  if (/invalid_grant/.test(text)) return 'The refresh token was revoked — mint a new one and update GOOGLE_ADS_REFRESH_TOKEN';
  return '';
}
function tiktokFix(code) {
  if (code === 40105 || code === 40102) return 'The access token is invalid or expired — generate a new long-term token in TikTok Ads Manager and update TIKTOK_ACCESS_TOKEN';
  if (code === 40001) return 'The request was malformed — usually a wrong advertiser id';
  if (code === 40100) return 'Rate limited — wait a minute and retry';
  if (code === 40104) return 'The token does not have permission on this advertiser — re-authorize with the right Business Center';
  return '';
}

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


/* ── ACCOUNT DISCOVERY: every account the credentials can reach ─────
   Used by the app's "Discover clients" button to build the client roster. */
async function googleAccounts(env) {
  const dev = env.GOOGLE_ADS_DEVELOPER_TOKEN;
  if (!dev) return json({ error: 'GOOGLE_ADS_DEVELOPER_TOKEN secret is not set' });
  const tok = await googleAccessToken(env);
  if (tok.error) return json({ error: tok.error });
  const headers = { Authorization: 'Bearer ' + tok.token, 'developer-token': dev, 'Content-Type': 'application/json' };
  const mgr = String(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');

  // With a manager account, list the clients under it (names included).
  if (mgr) {
    headers['login-customer-id'] = mgr;
    const q = `SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.status, customer_client.currency_code
               FROM customer_client WHERE customer_client.status = 'ENABLED'`;
    const res = await fetch(`https://googleads.googleapis.com/${GOOGLE_V}/customers/${mgr}/googleAds:searchStream`,
      { method: 'POST', headers, body: JSON.stringify({ query: q }) });
    const text = await res.text();
    if (res.ok) {
      let batches; try { batches = JSON.parse(text); } catch (_) { batches = []; }
      const accounts = [];
      (Array.isArray(batches) ? batches : [batches]).forEach((b) => (b.results || []).forEach((r) => {
        const c = r.customerClient || {};
        if (c.manager) return;                       // skip manager nodes, keep real accounts
        accounts.push({ id: String(c.id), name: c.descriptiveName || String(c.id), currency: c.currencyCode });
      }));
      return json({ accounts });
    }
  }
  // No manager configured — fall back to the directly accessible customers.
  const r = await fetch(`https://googleads.googleapis.com/${GOOGLE_V}/customers:listAccessibleCustomers`, { headers });
  const t = await r.text();
  if (!r.ok) return json({ error: 'Google ' + r.status + ': ' + t.slice(0, 300) });
  let d; try { d = JSON.parse(t); } catch (_) { return json({ error: 'Bad Google response' }); }
  const accounts = (d.resourceNames || []).map((rn) => {
    const id = String(rn).split('/').pop();
    return { id, name: id };
  });
  return json({ accounts });
}

async function tiktokAccounts(body, env) {
  const token = env.TIKTOK_ACCESS_TOKEN || body.accessToken;
  if (!token) return json({ error: 'TikTok not configured (set TIKTOK_ACCESS_TOKEN)' });
  const appId = env.TIKTOK_APP_ID, secret = env.TIKTOK_APP_SECRET;
  if (!appId || !secret) return json({ error: 'Set TIKTOK_APP_ID and TIKTOK_APP_SECRET to list advertisers' });
  const base = 'https://business-api.tiktok.com/open_api/v1.3';
  const auth = await (await fetch(`${base}/oauth2/advertiser/get/?app_id=${encodeURIComponent(appId)}&secret=${encodeURIComponent(secret)}`,
    { headers: { 'Access-Token': token } })).json();
  if (auth.code !== 0) return json({ error: 'TikTok ' + auth.code + ': ' + (auth.message || 'error') });
  const ids = ((auth.data && auth.data.list) || []).map((a) => a.advertiser_id);
  if (!ids.length) return json({ accounts: [] });
  const info = await (await fetch(`${base}/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify(ids))}`,
    { headers: { 'Access-Token': token } })).json();
  const names = {};
  if (info.code === 0) ((info.data && info.data.list) || []).forEach((a) => {
    names[a.advertiser_id] = { name: a.name || a.advertiser_name, currency: a.currency };
  });
  return json({ accounts: ids.map((id) => ({ id: String(id),
    name: (names[id] && names[id].name) || String(id), currency: names[id] && names[id].currency })) });
}

async function linkedinAccounts(body, env) {
  const token = env.LINKEDIN_ACCESS_TOKEN || body.accessToken;
  if (!token) return json({ error: 'LinkedIn not configured (set LINKEDIN_ACCESS_TOKEN)' });
  const r = await fetch('https://api.linkedin.com/rest/adAccounts?q=search&pageSize=100', {
    headers: { Authorization: 'Bearer ' + token, 'LinkedIn-Version': env.LINKEDIN_VERSION || '202506', 'X-Restli-Protocol-Version': '2.0.0' },
  });
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch (_) { d = null; }
  if (!r.ok) return json({ error: 'LinkedIn ' + r.status + ': ' + ((d && d.message) || t.slice(0, 200)) });
  const accounts = ((d && d.elements) || []).map((a) => ({ id: String(a.id), name: a.name || String(a.id), currency: a.currency }));
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

  // Sync GET — follow cursor pagination up to 1,000 rows (10 pages),
  // which is what the app's tool description promises.
  let url = `${baseNode}?${toForm().toString()}`;
  const rows = [];
  let next = url, pages = 0, truncated = false;
  while (next && pages++ < 10) {
    const data = await (await fetch(next)).json();
    if (data.error) return json({ error: 'Facebook: ' + data.error.message });
    rows.push(...(data.data || []));
    next = data.paging && data.paging.next;
    if (rows.length >= 1000) { truncated = !!next; break; }
  }
  if (next && pages >= 10) truncated = true;
  return json({ data: rows, total: rows.length, truncated });
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
  // The MCC header is the #1 fix for Google 401/403s — fall back to the
  // worker secret so it applies even when the app never sends a managerId.
  const mgr = String(managerId || env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '');
  if (mgr && mgr !== cid) headers['login-customer-id'] = mgr;

  const url = `https://googleads.googleapis.com/${GOOGLE_V}/customers/${cid}/googleAds:searchStream`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query: gaql }) });
  const text = await res.text();
  if (!res.ok) {
    const fix = googleFix(text);
    return json({ error: googleErr(res.status, text) + (fix ? ' — FIX: ' + fix : '') });
  }

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

  // Advertiser record — the account's own name / currency / timezone.
  if (action === 'advertiser_info') {
    const info = await (await fetch(`${base}/advertiser/info/?advertiser_ids=${encodeURIComponent(JSON.stringify([String(adv)]))}`,
      { headers: { 'Access-Token': token } })).json();
    if (info.code !== 0) return json({ error: 'TikTok ' + info.code + ': ' + (info.message || 'error') });
    const a = ((info.data && info.data.list) || [])[0] || {};
    return json({ data: [a], total: 1, currency: a.currency });
  }

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
  // Refresh-first: a refresh trio alone is a valid configuration (access
  // tokens die every 60 days; the refresh token is what keeps working).
  if (!token && !(await tryRefresh()))
    return json({ error: 'LinkedIn not configured — set LINKEDIN_ACCESS_TOKEN, or the refresh trio (LINKEDIN_REFRESH_TOKEN + LINKEDIN_CLIENT_ID/SECRET), or add your token in the app Configuration' });

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

/* ── PINTEREST Ads (API v5) ───────────────────────────────────────── */
// Actions: analytics (default) | campaigns | accounts
// Spend metrics arrive in micro-dollars; matching plain-currency fields
// (SPEND, ECPC_…) are added alongside so callers never divide themselves.
function pinNormalize(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const k in row) {
    if (/_IN_MICRO_DOLLAR$/.test(k)) out[k.replace(/_IN_MICRO_DOLLAR$/, '')] = +(Number(row[k] || 0) / 1e6).toFixed(2);
  }
  return out;
}

async function pinterestAds(body, env) {
  let token = env.PINTEREST_ACCESS_TOKEN || body.accessToken;
  if (!token) return json({ error: 'Pinterest not configured — set the PINTEREST_ACCESS_TOKEN worker secret, or add your token in the app Configuration' });

  const BASE = 'https://api.pinterest.com/v5';
  const acctId = String(body.accountId || env.PINTEREST_AD_ACCOUNT_ID || '').trim();
  const action = body.action || 'analytics';

  // Refresh-on-401: needs PINTEREST_CLIENT_ID / PINTEREST_CLIENT_SECRET plus a refresh token.
  const refreshToken = env.PINTEREST_REFRESH_TOKEN || body.refreshToken;
  let refreshed = false;
  const tryRefresh = async () => {
    if (refreshed || !refreshToken || !env.PINTEREST_CLIENT_ID || !env.PINTEREST_CLIENT_SECRET) return false;
    refreshed = true;
    const r = await fetch(`${BASE}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + btoa(env.PINTEREST_CLIENT_ID + ':' + env.PINTEREST_CLIENT_SECRET),
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const d = await r.json().catch(() => null);
    if (d && d.access_token) { token = d.access_token; return true; }
    return false;
  };

  const pFetch = async (url) => {
    let res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (res.status === 401 && await tryRefresh()) {
      res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!res.ok) return { error: 'Pinterest ' + res.status + ': ' + ((data && data.message) || text.slice(0, 300)) };
    return { data };
  };

  if (action === 'accounts') {
    const r = await pFetch(`${BASE}/ad_accounts?page_size=100`);
    if (r.error) return json(r);
    const rows = (r.data && r.data.items) || [];
    return json({ data: rows, total: rows.length });
  }

  if (!acctId) return json({ error: 'No Pinterest ad account ID — set it in the app Configuration, or use action:"accounts" to list accessible accounts' });

  // The ad-account record itself — name / currency / country.
  if (action === 'account') {
    const r = await pFetch(`${BASE}/ad_accounts/${acctId}`);
    if (r.error) return json(r);
    return json({ data: [r.data], total: 1, currency: r.data && r.data.currency });
  }

  if (action === 'campaigns') {
    let url = `${BASE}/ad_accounts/${acctId}/campaigns?page_size=100`;
    if (body.statuses) url += '&entity_statuses=' + encodeURIComponent([].concat(body.statuses).join(','));
    const r = await pFetch(url);
    if (r.error) return json(r);
    const rows = (r.data && r.data.items) || [];
    return json({ data: rows, total: rows.length });
  }

  // ── analytics (default) ──
  const day = (d) => d.toISOString().slice(0, 10);
  const endDate = body.endDate || day(new Date());
  const startDate = body.startDate || day(new Date(Date.now() - 30 * 864e5));
  const columns = (Array.isArray(body.columns) && body.columns.length ? body.columns
    : ['SPEND_IN_MICRO_DOLLAR', 'IMPRESSION_2', 'CLICKTHROUGH_2', 'TOTAL_CONVERSIONS']).join(',');
  const gran = body.granularity || 'TOTAL';
  const range = `start_date=${startDate}&end_date=${endDate}&columns=${encodeURIComponent(columns)}&granularity=${gran}`;

  const campAnalytics = async (ids, names) => {
    const r = await pFetch(`${BASE}/ad_accounts/${acctId}/campaigns/analytics?campaign_ids=${encodeURIComponent(ids.join(','))}&${range}`);
    if (r.error) return r;
    const arr = Array.isArray(r.data) ? r.data : ((r.data && r.data.items) || []);
    return { rows: arr.map(pinNormalize).map((row) => (names && names[row.CAMPAIGN_ID]
      ? { ...row, CAMPAIGN_NAME: row.CAMPAIGN_NAME || names[row.CAMPAIGN_ID] } : row)) };
  };

  if (Array.isArray(body.campaignIds) && body.campaignIds.length) {
    const r = await campAnalytics(body.campaignIds.slice(0, 100));
    if (r.error) return json(r);
    return json({ data: r.rows, total: r.rows.length, dateRange: { start: startDate, end: endDate } });
  }
  if (body.level === 'campaign') {
    // No ids given — list campaigns first, then pull their analytics in one call.
    const c = await pFetch(`${BASE}/ad_accounts/${acctId}/campaigns?page_size=100`);
    if (c.error) return json(c);
    const camps = (c.data && c.data.items) || [];
    if (!camps.length) return json({ data: [], total: 0, dateRange: { start: startDate, end: endDate } });
    const names = {}; camps.forEach((x) => { names[x.id] = x.name; });
    const r = await campAnalytics(camps.slice(0, 100).map((x) => x.id), names);
    if (r.error) return json(r);
    return json({ data: r.rows, total: r.rows.length, dateRange: { start: startDate, end: endDate } });
  }

  // account-level analytics
  const r = await pFetch(`${BASE}/ad_accounts/${acctId}/analytics?${range}`);
  if (r.error) return json(r);
  const arr = Array.isArray(r.data) ? r.data : ((r.data && r.data.items) || [r.data]);
  const rows = arr.map(pinNormalize);
  return json({ data: rows, total: rows.length, dateRange: { start: startDate, end: endDate } });
}

async function pinterestAccounts(body, env) {
  const r = await pinterestAds({ ...body, action: 'accounts' }, env);
  const d = await r.json();
  if (d.error) return json({ error: d.error });
  const accounts = (d.data || []).map((a) => ({ id: String(a.id), name: a.name || String(a.id), currency: a.currency }));
  return json({ accounts });
}

/* ── REDDIT Ads (API v3) ──────────────────────────────────────────── */
// Actions: report (default) | campaigns | accounts
// Reddit access tokens expire after ~24h, so the refresh trio
// (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET / REDDIT_REFRESH_TOKEN) is what
// keeps this working unattended. Spend arrives in micro-currency — the
// handler converts it to plain units before returning.
async function redditAds(body, env) {
  let token = env.REDDIT_ACCESS_TOKEN || body.accessToken;
  const refreshToken = env.REDDIT_REFRESH_TOKEN || body.refreshToken;
  if (!token && !refreshToken) return json({ error: 'Reddit not configured — set REDDIT_REFRESH_TOKEN (+ REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET), or add a token in the app Configuration' });

  const BASE = 'https://ads-api.reddit.com/api/v3';
  const UA = 'cmm-ads-intelligence/1.0';
  const acctId = String(body.accountId || env.REDDIT_AD_ACCOUNT_ID || '').trim();
  const action = body.action || 'report';

  let refreshed = false;
  const tryRefresh = async () => {
    if (refreshed || !refreshToken || !env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) return false;
    refreshed = true;
    const r = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + btoa(env.REDDIT_CLIENT_ID + ':' + env.REDDIT_CLIENT_SECRET),
        'User-Agent': UA,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    const d = await r.json().catch(() => null);
    if (d && d.access_token) { token = d.access_token; return true; }
    return false;
  };
  if (!token && !(await tryRefresh())) return json({ error: 'Reddit token refresh failed — check REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET / REDDIT_REFRESH_TOKEN' });

  const rFetch = async (url, init) => {
    const mk = () => ({ ...(init || {}),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': UA } });
    let res = await fetch(url, mk());
    if (res.status === 401 && await tryRefresh()) res = await fetch(url, mk());
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch (_) { data = null; }
    if (!res.ok) {
      const msg = (data && (data.message || (data.error && (data.error.message || data.error)))) || text.slice(0, 300);
      return { error: 'Reddit ' + res.status + ': ' + (typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 300)) };
    }
    return { data };
  };

  if (action === 'accounts') {
    const r = await rFetch(`${BASE}/ad_accounts?page.size=100`);
    if (r.error) return json(r);
    const rows = (r.data && r.data.data) || [];
    return json({ data: rows, total: rows.length });
  }

  if (!acctId) return json({ error: 'No Reddit ad account ID — set it in the app Configuration, or use action:"accounts" to list accessible accounts' });

  // The ad-account record itself — name / currency.
  if (action === 'account') {
    const r = await rFetch(`${BASE}/ad_accounts/${acctId}`);
    if (r.error) return json(r);
    const a = (r.data && r.data.data) || {};
    return json({ data: [a], total: 1, currency: a.currency });
  }

  if (action === 'campaigns') {
    const r = await rFetch(`${BASE}/ad_accounts/${acctId}/campaigns?page.size=100`);
    if (r.error) return json(r);
    const rows = (r.data && r.data.data) || [];
    return json({ data: rows, total: rows.length });
  }

  // ── report (default) ──
  const iso = (s, endOfDay) => (/T/.test(String(s)) ? s : s + (endOfDay ? 'T23:59:59Z' : 'T00:00:00Z'));
  const day = (d) => d.toISOString().slice(0, 10);
  const endDate = body.endDate || day(new Date());
  const startDate = body.startDate || day(new Date(Date.now() - 30 * 864e5));
  const breakdowns = (Array.isArray(body.breakdowns) && body.breakdowns.length) ? body.breakdowns
    : (body.granularity === 'DAY' ? ['campaign_id', 'date'] : ['campaign_id']);
  const fields = (Array.isArray(body.fields) && body.fields.length ? body.fields
    : ['spend', 'impressions', 'clicks', 'ctr', 'cpc']);

  // Campaign names aren't in the report — join them in when campaign_id is a breakdown.
  let names = null;
  if (breakdowns.includes('campaign_id')) {
    const c = await rFetch(`${BASE}/ad_accounts/${acctId}/campaigns?page.size=100`);
    if (!c.error) { names = {}; ((c.data && c.data.data) || []).forEach((x) => { names[x.id] = x.name; }); }
  }

  const r = await rFetch(`${BASE}/ad_accounts/${acctId}/reports`, {
    method: 'POST',
    body: JSON.stringify({ data: {
      breakdowns, fields,
      starts_at: iso(startDate), ends_at: iso(endDate, true),
      time_zone_id: body.timezone || 'GMT',
    } }),
  });
  if (r.error) return json(r);
  const metrics = (r.data && r.data.data && r.data.data.metrics) || [];
  const rows = metrics.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const out = { ...m };
    if (out.spend != null) out.spend = +(Number(out.spend) / 1e6).toFixed(2);   // micro-currency → plain
    if (out.cpc != null) out.cpc = +(Number(out.cpc) / 1e6).toFixed(2);
    if (names && out.campaign_id != null && names[out.campaign_id]) out.campaign_name = names[out.campaign_id];
    return out;
  });
  return json({ data: rows, total: rows.length, dateRange: { start: startDate, end: endDate } });
}

async function redditAccounts(body, env) {
  const r = await redditAds({ ...body, action: 'accounts' }, env);
  const d = await r.json();
  if (d.error) return json({ error: d.error });
  const accounts = (d.data || []).map((a) => ({ id: String(a.id), name: a.name || String(a.id), currency: a.currency }));
  return json({ accounts });
}


/* ═══════════════════════════════════════════════════════════════════════════
   WHATSAPP — scheduled digests + two-way Q&A
   ---------------------------------------------------------------------------
   Secrets: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_RECIPIENTS (E.164,
   comma separated), WHATSAPP_VERIFY_TOKEN, WHATSAPP_TEMPLATE (default
   "ads_update"), WHATSAPP_TEMPLATE_LANG (default "en"), optional
   WHATSAPP_DIGEST_DAYS, CLIENTS_JSON, WHATSAPP_ALLOWED (numbers allowed to
   ask questions; defaults to WHATSAPP_RECIPIENTS).
   ═════════════════════════════════════════════════════════════════════════ */

const WA_V = 'v21.0';
const waNums = (v) => String(v || '').split(',').map((x) => x.trim().replace(/[^\d+]/g, '')).filter(Boolean);
const waDay = (d) => d.toISOString().slice(0, 10);
const waMoney = (n, cur) => (cur ? cur + ' ' : '$') + Math.round(Number(n) || 0).toLocaleString('en-US');

/* Client roster for the worker. CLIENTS_JSON wins; otherwise every Meta ad
   account the token can reach becomes a client, so the digest works with no
   extra configuration. */
async function waClients(env) {
  if (env.CLIENTS_JSON) {
    try { const c = JSON.parse(env.CLIENTS_JSON); if (Array.isArray(c) && c.length) return c; } catch (_) {}
  }
  const r = await metaAccounts(env);
  const d = await r.json();
  if (d.error) return [];
  return (d.accounts || []).map((a) => ({ name: a.name, meta: { act: a.id }, currency: a.currency }));
}

/* Spend per client for a window, plus the previous window for comparison. */
async function waPortfolio(env, days) {
  const clients = await waClients(env);
  const end = new Date(); end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - 1);                       // yesterday, complete
  const start = new Date(end.getTime() - (days - 1) * 864e5);
  const pStart = new Date(start.getTime() - days * 864e5);
  const pEnd = new Date(start.getTime() - 864e5);

  const spendFor = async (act, a, b) => {
    const res = await metaAds({
      adAccountId: act, path: '/insights',
      params: { level: 'account', fields: 'spend,impressions,clicks,account_currency',
                time_range: JSON.stringify({ since: waDay(a), until: waDay(b) }) },
    }, env);
    const j = await res.json();
    if (j.error) throw new Error(j.error);
    const row = (j.data || [])[0] || {};
    return { spend: Number(row.spend || 0), impressions: Number(row.impressions || 0),
             clicks: Number(row.clicks || 0), currency: row.account_currency || 'USD' };
  };

  const rows = await Promise.all(clients.map(async (c) => {
    const act = c.meta && c.meta.act;
    if (!act) return null;
    try {
      const [cur, prev] = await Promise.all([spendFor(act, start, end), spendFor(act, pStart, pEnd)]);
      return { name: c.name, ...cur, prevSpend: prev.spend };
    } catch (e) { return { name: c.name, error: String(e.message || e) }; }
  }));

  const ok = rows.filter((r) => r && !r.error);
  const bad = rows.filter((r) => r && r.error);
  /* Totals are summed per currency — never add across currencies. */
  const byCur = {};
  ok.forEach((r) => { byCur[r.currency] = byCur[r.currency] || { spend: 0, prev: 0, clicks: 0, impressions: 0 };
    byCur[r.currency].spend += r.spend; byCur[r.currency].prev += r.prevSpend;
    byCur[r.currency].clicks += r.clicks; byCur[r.currency].impressions += r.impressions; });
  ok.sort((a, b) => b.spend - a.spend);
  return { start: waDay(start), end: waDay(end), days, clients: ok, failed: bad, byCurrency: byCur };
}

/* Compact digest lines — WhatsApp caps a message at 4096 chars. */
function waDigestBody(p) {
  const period = p.days === 1 ? p.end : p.start + ' → ' + p.end;
  const cur = Object.entries(p.byCurrency);
  const totals = cur.map(([c, v]) => {
    const d = v.prev > 0 ? ((v.spend - v.prev) / v.prev) * 100 : null;
    const arrow = d == null ? '' : (d >= 0 ? ' (▲' : ' (▼') + Math.abs(d).toFixed(0) + '% vs prior)';
    return waMoney(v.spend, c) + arrow;
  }).join(' · ');
  const lines = p.clients.slice(0, 12).map((c) => {
    const d = c.prevSpend > 0 ? ((c.spend - c.prevSpend) / c.prevSpend) * 100 : null;
    const chg = d == null ? '' : ' ' + (d >= 0 ? '▲' : '▼') + Math.abs(d).toFixed(0) + '%';
    const ctr = c.impressions > 0 ? ' · CTR ' + ((c.clicks / c.impressions) * 100).toFixed(2) + '%' : '';
    return '• ' + c.name + ': ' + waMoney(c.spend, c.currency) + chg + ctr;
  });
  if (p.clients.length > 12) lines.push('…and ' + (p.clients.length - 12) + ' more');
  if (p.failed.length) lines.push('⚠️ No data: ' + p.failed.map((f) => f.name).join(', '));
  return { period, totals: totals || 'no spend', body: lines.join('\n') };
}

async function waSendText(env, to, text) {
  const r = await fetch(`https://graph.facebook.com/${WA_V}/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text',
      text: { preview_url: false, body: String(text).slice(0, 4000) } }),
  });
  return { to, status: r.status, body: (await r.text()).slice(0, 300) };
}

/* Proactive (unprompted) sends must use an approved template. */
async function waSendTemplate(env, to, params) {
  const r = await fetch(`https://graph.facebook.com/${WA_V}/${env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.WHATSAPP_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name: env.WHATSAPP_TEMPLATE || 'ads_update',
        language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t).slice(0, 900) })) }],
      },
    }),
  });
  return { to, status: r.status, body: (await r.text()).slice(0, 300) };
}

async function waRunDigest(env, days, dryRun) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID)
    return { error: 'WHATSAPP_TOKEN and WHATSAPP_PHONE_ID must be set' };
  const p = await waPortfolio(env, days || 1);
  const d = waDigestBody(p);
  const label = (days || 1) === 1 ? 'Yesterday' : 'Last ' + days + ' days';
  if (dryRun) return { preview: { period: d.period, totals: d.totals, body: d.body }, clients: p.clients.length };
  const to = waNums(env.WHATSAPP_RECIPIENTS);
  if (!to.length) return { error: 'WHATSAPP_RECIPIENTS is empty' };
  const sent = await Promise.all(to.map((n) =>
    waSendTemplate(env, n, [label + ' · ' + d.period, d.totals, d.body || 'No spend recorded'])
      .catch((e) => ({ to: n, error: String(e.message || e) }))));
  return { sent, clients: p.clients.length, period: d.period };
}

async function waTest(body, env) {
  const to = body.to ? waNums(body.to) : waNums(env.WHATSAPP_RECIPIENTS);
  if (!to.length) return json({ error: 'No recipient — pass "to" or set WHATSAPP_RECIPIENTS' });
  const out = await Promise.all(to.map((n) => waSendText(env, n, body.text || 'CMM Ads Intelligence — test message ✅')));
  return json({ sent: out, note: 'Free-form text only reaches numbers that messaged you in the last 24h; otherwise use the template digest.' });
}

/* ── Inbound: reply to questions with the same tools the app uses ── */
async function waInbound(request, env, ctx) {
  let payload = {};
  try { payload = await request.json(); } catch (_) {}
  ctx.waitUntil((async () => {
    try {
      const v = ((payload.entry || [])[0] || {});
      const ch = ((v.changes || [])[0] || {}).value || {};
      const msg = (ch.messages || [])[0];
      if (!msg || msg.type !== 'text') return;
      const from = msg.from;
      const allowed = waNums(env.WHATSAPP_ALLOWED || env.WHATSAPP_RECIPIENTS);
      if (allowed.length && !allowed.some((a) => a.replace(/^\+/, '') === String(from).replace(/^\+/, ''))) {
        await waSendText(env, from, 'This number is not authorised for ads reporting.');
        return;
      }
      const q = (msg.text && msg.text.body || '').trim();
      if (!q) return;
      if (/^(digest|report|summary)$/i.test(q)) {
        const p = await waPortfolio(env, 1); const d = waDigestBody(p);
        await waSendText(env, from, `*Ads update · ${d.period}*\n${d.totals}\n\n${d.body}`);
        return;
      }
      const answer = await waAgent(env, q);
      await waSendText(env, from, answer);
    } catch (e) {
      try { const f = (((payload.entry || [])[0] || {}).changes || [])[0].value.messages[0].from;
        await waSendText(env, f, '⚠️ Could not answer that: ' + String(e.message || e).slice(0, 200)); } catch (_) {}
    }
  })());
  return new Response('OK', { status: 200 });   // Meta needs a fast 200
}

/* Small agent loop: Claude + the ad tools, answering in plain WhatsApp text. */
async function waAgent(env, question) {
  const key = env.ANTHROPIC_API_KEY || env.CLAUDE_KEY || env.CLAUDE_API_KEY || env.ANTHROPIC_KEY;
  if (!key) return 'The ANTHROPIC_API_KEY secret is not set on the worker.';
  const roster = await waClients(env);
  const tools = [
    { name: 'list_clients', description: 'List configured clients and their Meta ad account ids.',
      input_schema: { type: 'object', properties: {}, required: [] } },
    { name: 'query_meta_ads',
      description: 'Meta Marketing API GET. path is relative to the ad account, e.g. "/insights" or "/campaigns". Omit clients to query EVERY client.',
      input_schema: { type: 'object', properties: {
        path: { type: 'string' }, params: { type: 'object' },
        clients: { type: 'array', items: { type: 'string' }, description: 'Client names; omit for all' } },
        required: ['path'] } },
    { name: 'query_google_ads', description: 'Run a GAQL query against a Google Ads customer id.',
      input_schema: { type: 'object', properties: { gaql: { type: 'string' }, customerId: { type: 'string' } }, required: ['gaql'] } },
  ];
  const today = new Date().toISOString().slice(0, 10);
  const system = `You are the CMM Ads Intelligence assistant replying over WhatsApp. Today is ${today}.
Answer in plain text for a phone: no markdown tables, no headings. Use short lines and "•" bullets, at most ~12 lines, under 1200 characters.
Always state the date range and which clients the numbers cover. Compute rates from summed components (CTR = total clicks / total impressions). Never add spend across different currencies — group by currency and say so. If a client failed, say which.
Clients available: ${roster.map((c) => c.name).join(', ') || 'none'}.`;
  const messages = [{ role: 'user', content: question }];

  for (let i = 0; i < 6; i++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: env.WHATSAPP_MODEL || 'claude-sonnet-5', max_tokens: 2048, system, tools, messages }),
    });
    const data = await res.json();
    if (data.error) return 'API error: ' + (data.error.message || 'unknown');
    const uses = (data.content || []).filter((b) => b.type === 'tool_use');
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (!uses.length) return text || 'No answer produced.';
    messages.push({ role: 'assistant', content: data.content });

    const results = await Promise.all(uses.map(async (u) => {
      let out;
      try {
        if (u.name === 'list_clients') {
          out = { clients: roster.map((c) => ({ name: c.name, meta: c.meta && c.meta.act })) };
        } else if (u.name === 'query_meta_ads') {
          const want = u.input.clients;
          const targets = roster.filter((c) => c.meta && c.meta.act).filter((c) => !want || !want.length ||
            want.some((w) => c.name.toLowerCase().includes(String(w).toLowerCase())));
          const rows = [];
          await Promise.all(targets.map(async (c) => {
            const r = await metaAds({ adAccountId: c.meta.act, path: u.input.path, params: u.input.params || {} }, env);
            const j = await r.json();
            if (j.error) { rows.push({ _client: c.name, error: j.error }); return; }
            (j.data || []).forEach((row) => rows.push(Object.assign({ _client: c.name }, row)));
          }));
          out = { clients_queried: targets.map((c) => c.name), total_rows: rows.length, rows };
        } else if (u.name === 'query_google_ads') {
          const r = await googleAds({ customerId: u.input.customerId || env.GOOGLE_ADS_CUSTOMER_ID, gaql: u.input.gaql }, env);
          out = await r.json();
        } else { out = { error: 'unknown tool' }; }
      } catch (e) { out = { error: String(e.message || e) }; }
      const s = JSON.stringify(out);
      return { type: 'tool_result', tool_use_id: u.id, content: s.length > 60000 ? s.slice(0, 60000) + '…truncated' : s };
    }));
    messages.push({ role: 'user', content: results });
  }
  return 'That took too many steps — try a narrower question (one client or a shorter period).';
}
