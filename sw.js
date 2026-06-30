// ─────────────────────────────────────────────────────────────────────────────
// SELF-DESTRUCTING SERVICE WORKER
//
// An earlier build registered a cache-first service worker (cache "cmm-ai-v1")
// that pinned ./index.html in users' browsers, so they kept seeing a stale page
// even after new deploys. This version replaces it: on activation it deletes ALL
// caches, unregisters itself, and reloads open tabs so every visitor recovers the
// live page automatically. The current app does not use a service worker.
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('install', () => {
  // Take over immediately instead of waiting for the old worker to be released.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    try {
      await self.registration.unregister();
    } catch (e) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => c.navigate(c.url));
    } catch (e) {}
  })());
});

// Pass every request straight to the network — no caching.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
