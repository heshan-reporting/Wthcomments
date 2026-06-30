// ─────────────────────────────────────────────────────────────────────────────
// FIX: "Worker 400: Unknown source: meta_accounts"
//
// Your Cloudflare Worker handles the data source "meta_ads" but has no handler
// for "meta_accounts" (the request the app sends when you click
// "Load my ad accounts"), so it falls through to the "Unknown source" error.
//
// HOW TO APPLY
//   1. Open dash.cloudflare.com → Workers & Pages → your worker → Edit code.
//   2. Find the place that dispatches on `source` — it's wherever the string
//      "Unknown source" is returned, and right next to your existing
//      `if (source === 'meta_ads') { ... }` block.
//   3. Paste the block below right BEFORE the "Unknown source" fallback.
//   4. Deploy. No app change or secret change needed — it reuses the same
//      META_ACCESS_TOKEN secret your meta_ads handler already uses.
// ─────────────────────────────────────────────────────────────────────────────

if (source === 'meta_accounts') {
  const token = env.META_ACCESS_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: 'META_ACCESS_TOKEN secret is not set on the worker' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  // me/adaccounts returns every ad account the token's user can access.
  // Each node's `id` is already in "act_XXXXXXXX" form, which is exactly what the app stores.
  const fields = 'name,account_status,currency,timezone_name';
  const url = `https://graph.facebook.com/v19.0/me/adaccounts?fields=${fields}&limit=500&access_token=${encodeURIComponent(token)}`;

  const fb = await (await fetch(url)).json();

  if (fb.error) {
    return new Response(JSON.stringify({ error: 'Facebook: ' + (fb.error.message || 'Graph error') }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  const accounts = (fb.data || []).map(function (a) {
    return {
      id: a.id,                       // "act_1427075252328347"
      name: a.name || a.id,
      account_status: a.account_status, // 1 = active (drives the Active/Inactive badge)
      currency: a.currency,
      timezone: a.timezone_name
    };
  });

  return new Response(JSON.stringify({ accounts: accounts }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
