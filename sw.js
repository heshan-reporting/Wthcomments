// ─────────────────────────────────────────────────────────────────────────────
// CMM Ads Intelligence — network-first service worker
//
// Strategy: every GET goes to the network FIRST; the cache is only a fallback
// for when the network is unreachable. This keeps the app installable and
// usable offline without ever pinning a stale index.html (the failure mode of
// the old cache-first "cmm-ai-v1" worker, which this version also cleans up
// by deleting every cache that isn't the current one).
// ─────────────────────────────────────────────────────────────────────────────

const CACHE = 'cmm-ai-v2';

// App shell precached on install so the first offline launch still works.
const SHELL = ['./', './index.html', './manifest.json', './icon-180.png', './icon-512.png'];

// Cross-origin hosts whose GET responses are safe and useful to keep for
// offline (fonts + the CDN libs the app needs to boot). API calls (the
// workers.dev proxy) and the login video are deliberately NOT cached.
const CACHEABLE_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isCacheable(request, url) {
  if (request.method !== 'GET') return false;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  if (url.origin === self.location.origin) return true;
  return CACHEABLE_HOSTS.includes(url.hostname);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (!isCacheable(request, url)) return; // pass through untouched (APIs, POSTs, video)

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      // Only keep good responses; never overwrite the cache with an error page.
      if (response && response.ok) {
        const copy = response.clone();
        event.waitUntil(
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {})
        );
      }
      return response;
    } catch (err) {
      const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
