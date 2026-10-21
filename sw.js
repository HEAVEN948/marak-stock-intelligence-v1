// Marak Stock Intelligence — service worker
// IMPORTANT: bump CACHE_VERSION every time you redeploy index.html, or installed users will keep seeing the old cached version.
const CACHE_VERSION = 'msi-v33';
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
      Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== 'msi-cfg').map((k) => caches.delete(k)))
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

// Push alerts: the Worker sends an empty push; we fetch the message text from it and show a notification.
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let msgs = [];
    try {
      const c = await caches.open('msi-cfg');
      const r = await c.match('./msi-cfg.json');
      if (r) {
        const { url, uid } = await r.json();
        const res = await fetch(url + '/pending?uid=' + encodeURIComponent(uid));
        msgs = await res.json();
      }
    } catch (e) { /* fall through to a generic notification */ }
    if (!msgs.length) msgs = [{ title: 'Price alert', body: 'A support/resistance line was touched. Open the app.', tag: 'msi-generic' }];
    await Promise.all(msgs.map((m) => self.registration.showNotification(m.title, {
      body: m.body, tag: m.tag, renotify: true, requireInteraction: true,
      icon: './icon-192.png', badge: './icon-192.png', vibrate: [300, 150, 300, 150, 300]
    })));
  })());
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
