// ─────────────────────────────────────────────────────────────────────────────
// CMM Ads Intelligence — PWA service worker
//
// Strategy chosen to avoid the stale-page bug an old cache-first worker caused:
//   • Navigations (index.html): NETWORK-FIRST. Online users always get the
//     freshest deploy; the cached copy is only served when offline.
//   • Same-origin static assets (icons, manifest): stale-while-revalidate.
//   • Cross-origin requests (CDNs, video, APIs) are never intercepted.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE = 'cmm-app-v2';
const PRECACHE = ['./', './index.html', './manifest.json', './icon-180.png', './icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch CDN/video/API traffic

  if (req.mode === 'navigate') {
    // network-first: fresh page when online, cached shell when offline
    event.respondWith((async () => {
      try {
        const net = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', net.clone()).catch(() => {});
        return net;
      } catch (e) {
        const hit = await caches.match('./index.html');
        if (hit) return hit;
        throw e;
      }
    })());
    return;
  }

  // static assets: serve cache immediately, refresh it in the background
  event.respondWith((async () => {
    const hit = await caches.match(req);
    const refresh = fetch(req).then((net) => {
      if (net && net.ok) {
        caches.open(CACHE).then((c) => c.put(req, net.clone())).catch(() => {});
      }
      return net;
    }).catch(() => hit);
    if (hit) {
      event.waitUntil(refresh.catch(() => {}));
      return hit;
    }
    return refresh;
  })());
});
