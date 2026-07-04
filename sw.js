// Minimal offline cache for the app shell. The ML library + weights are fetched
// from CDN on first run and cached opportunistically so later runs work offline.
const CACHE = 'rally-reframe-v1';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/tracker.js',
  './js/renderer.js',
  './manifest.webmanifest',
  './icons/icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Cache-first for the shell, stale-while-revalidate for everything else (incl. CDN).
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
