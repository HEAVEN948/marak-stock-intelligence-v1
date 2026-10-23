// Marak Stock Intelligence — service worker
// Bump CACHE_VERSION whenever index.html or this worker changes.
const CACHE_VERSION = 'msi-v49-numbered-feature-sections';
const CORE_ASSETS = ['./', './index.html'];
const OPTIONAL_ASSETS = ['./manifest.json', './icon-192.png', './icon-512.png', './icon-512-maskable.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // Core assets must be available for installation; optional PWA assets must not
    // prevent the worker from installing if a repository does not contain them.
    await cache.addAll(CORE_ASSETS);
    await Promise.all(OPTIONAL_ASSETS.map(async (asset) => {
      try { await cache.add(asset); } catch (_) { /* optional asset is absent or unavailable */ }
    }));
  })());
  // Wait for the page's update banner to ask the waiting worker to activate.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_VERSION && key !== 'msi-cfg').map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// Only cache same-origin app files. Do not cache news/API responses, which can go stale.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {}));
      }
      return response;
    } catch (_) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return (await caches.match('./index.html')) || Response.error();
      }
      return Response.error();
    }
  })());
});

// Push alerts: the Worker sends an empty push; fetch the queued message and show it.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let msgs = [];
    try {
      const cache = await caches.open('msi-cfg');
      const response = await cache.match('./msi-cfg.json');
      if (response) {
        const { url, uid } = await response.json();
        const pending = await fetch(url + '/pending?uid=' + encodeURIComponent(uid));
        if (pending.ok) msgs = await pending.json();
      }
    } catch (_) { /* show a generic notification below */ }
    if (!Array.isArray(msgs) || !msgs.length) {
      msgs = [{ title: 'Price alert', body: 'A support/resistance line was touched. Open the app.', tag: 'msi-generic' }];
    }
    await Promise.all(msgs.map((message) => self.registration.showNotification(message.title || 'Price alert', {
      body: message.body || 'Open Marak Stock Intelligence to review your alert.',
      tag: message.tag || 'msi-alert', renotify: true, requireInteraction: true,
      icon: './icon-192.png', badge: './icon-192.png', vibrate: [300, 150, 300, 150, 300]
    })));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    for (const client of clients) {
      if ('focus' in client) return client.focus();
    }
    return self.clients.openWindow('./');
  }));
});
