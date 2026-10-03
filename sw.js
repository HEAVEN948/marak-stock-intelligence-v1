// Marak Stock Intelligence — service worker
// IMPORTANT: bump CACHE_VERSION every time you redeploy index.html, or installed users will keep seeing the old cached version.
const CACHE_VERSION = 'msi-v14';
const CORE_ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(CORE_ASSETS))
  );
  // Don't auto-activate — wait for the page to say it's ready (via the SKIP_WAITING message),
  // so we can show an "update available" prompt instead of silently swapping under the user.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Network-first for the app shell (so you always get the latest when online), cache fallback for offline use.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
