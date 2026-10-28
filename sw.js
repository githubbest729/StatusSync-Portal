/* StatusSync Portal — Service Worker */
'use strict';

const CACHE_NAME = 'STATUSSYNC_CACHE_v2026.4';
const RUNTIME_CACHE = 'STATUSSYNC_RUNTIME_v2026.4';
const OFFLINE_URL = './offline.html';

/* Core files are Network-First (cache only as the offline fallback) so a new GitHub Pages deploy shows immediately. */
const NETWORK_FIRST_PATHS = ['/index.html', '/css/styles.css', '/js/app.js', '/js/db.js', '/js/reports.js'];
function isNetworkFirst(url) {
  return NETWORK_FIRST_PATHS.some((p) => url.pathname.endsWith(p));
}

const APP_SHELL = [
  './',
  './index.html',
  './offline.html',
  './manifest.webmanifest',
  './favicon.svg',
  './favicon.ico',
  './apple-touch-icon.png',
  './css/styles.css',
  './js/db.js',
  './js/reports.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/favicon-32x32.png',
  './icons/favicon-16x16.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate the new worker immediately instead of waiting for old tabs to close
  // Static Routing API: serve static assets straight from the network when online,
  // bypassing worker startup. Offline fetches still reach the fetch handler below.
  try {
    if (event.addRoutes) {
      event.addRoutes([
        {
          // Images: when the worker is not running, race the network against the fetch handler
          // so a cold worker never delays online loads, while the handler still serves offline.
          condition: {
            urlPattern: new URLPattern({ pathname: '/*.(png|ico|svg|webp)' }),
            runningStatus: 'not-running'
          },
          source: 'race-network-and-fetch-handler'
        }
      ]);
    }
  } catch (err) {
    /* Static routing not supported or rejected: normal fetch handling applies. */
  }

  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(APP_SHELL.map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => null)
      ))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => k.startsWith('STATUSSYNC_') && k !== CACHE_NAME && k !== RUNTIME_CACHE)
      .map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) { /* ignore */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'VERSION', cache: CACHE_NAME });
  } else if (data.type === 'QUEUE_BROADCAST') {
    // Page asks the worker to remember a registration for sync; payload lives in IndexedDB.
    event.waitUntil(self.registration.sync
      ? self.registration.sync.register('sync-status-broadcasts').catch(() => null)
      : Promise.resolve());
  }
});

/* Web Share Target (POST, multipart): stash shared text/files in a cache, then redirect to the app. */
async function handleShareTarget(request) {
  const form = await request.formData();
  const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const cache = await caches.open('STATUSSYNC_SHARE');
  const files = form.getAll('files').filter((f) => f && typeof f === 'object' && 'name' in f);
  for (let i = 0; i < files.length; i++) {
    await cache.put('./__share/' + key + '/file/' + i, new Response(files[i], {
      headers: { 'Content-Type': files[i].type || 'application/octet-stream', 'X-Filename': encodeURIComponent(files[i].name) }
    }));
  }
  await cache.put('./__share/' + key + '/meta', new Response(JSON.stringify({
    title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', count: files.length
  }), { headers: { 'Content-Type': 'application/json' } }));
  return Response.redirect('./index.html?share=1&shareKey=' + key, 303);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === self.location.origin && url.searchParams.get('share-target') === '1') {
    event.respondWith(handleShareTarget(req).catch(() => Response.redirect('./index.html', 303)));
    return;
  }
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        if (preload) return preload;
        const net = await fetch(req);
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, net.clone()).catch(() => null);
        return net;
      } catch (err) {
        const cached = await caches.match(req, { ignoreSearch: true });
        if (cached) return cached;
        const shell = await caches.match('./index.html');
        if (shell) return shell;
        return (await caches.match(OFFLINE_URL)) || Response.error();
      }
    })());
    return;
  }

  // Network-First (fallback to cache) for the core app files.
  if (isNetworkFirst(url)) {
    event.respondWith((async () => {
      try {
        const net = await fetch(new Request(req, { cache: 'no-cache' }));
        if (net && net.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, net.clone()).catch(() => null);
        }
        return net;
      } catch (err) {
        const cached = (await caches.match(req, { ignoreSearch: true })) || (await caches.match(url.pathname));
        return cached || new Response('', { status: 504, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Stale-while-revalidate for everything else on this origin.
  event.respondWith((async () => {
    const cached = await caches.match(req);
    const refresh = fetch(req).then(async (res) => {
      if (res && res.ok) {
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put(req, res.clone()).catch(() => null);
      }
      return res;
    }).catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }
    const fresh = await refresh;
    if (fresh) return fresh;
    if (req.destination === 'document') return caches.match(OFFLINE_URL);
    return new Response('', { status: 504, statusText: 'Offline' });
  })());
});

/* ---------- IndexedDB access inside the worker (outbox for background sync) ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('StatusSyncDB_v2026');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function idbGetAll(db, store) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) return resolve([]);
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(db, store, key) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) return resolve(undefined);
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function notifyClients(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach((c) => c.postMessage(msg));
}

async function flushOutbox() {
  const db = await openDB();
  try {
    const row = await idbGet(db, 'app_meta', 'outbox');
    const ids = row && Array.isArray(row.value) ? row.value : [];
    const pending = [];
    for (const id of ids) {
      const entry = await idbGet(db, 'communication_log', id);
      if (entry && entry.syncState === 'queued') {
        entry.syncState = 'synced';
        entry.syncedAt = new Date().toISOString();
        await idbPut(db, 'communication_log', entry);
        pending.push(entry);
      }
    }
    if (ids.length) await idbPut(db, 'app_meta', { key: 'outbox', value: [] });
    if (pending.length) {
      await notifyClients({ type: 'SYNC_COMPLETE', count: pending.length });
      await self.registration.showNotification('StatusSync — broadcasts dispatched', {
        body: pending.length + ' queued status update(s) were sent now that you are back online.',
        icon: './icons/icon-192.png',
        badge: './icons/icon-96.png',
        tag: 'statussync-sync'
      });
    }
  } finally {
    db.close();
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-status-broadcasts') {
    event.waitUntil(flushOutbox());
  }
});

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'periodic-status-check') {
    event.waitUntil((async () => {
      const db = await openDB();
      try {
        const blockers = await idbGetAll(db, 'blockers_issues');
        const open = blockers.filter((b) => b.status !== 'Resolved');
        const critical = open.filter((b) => b.severity === 'Critical').length;
        await notifyClients({ type: 'PERIODIC_CHECK', open: open.length, critical });
        if (critical > 0) {
          await self.registration.showNotification('StatusSync — critical blockers open', {
            body: critical + ' critical blocker(s) still need PM attention.',
            icon: './icons/icon-192.png',
            badge: './icons/icon-96.png',
            tag: 'statussync-periodic',
            data: { url: './index.html?action=blocker' },
            actions: [
              { action: 'open', title: 'Open Portal' },
              { action: 'ack', title: 'Acknowledge' }
            ]
          });
        }
      } finally {
        db.close();
      }
    })());
  }
});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (e) {
    payload = { title: 'StatusSync', body: event.data ? event.data.text() : '' };
  }
  // Declarative Web Push shape: { web_push: 8030, notification: { title, body, navigate } }
  const n = payload.notification || payload;
  const title = n.title || 'StatusSync update';
  event.waitUntil(self.registration.showNotification(title, {
    body: n.body || 'A new project status update is available.',
    icon: './icons/icon-192.png',
    badge: './icons/icon-96.png',
    tag: n.tag || 'statussync-push',
    renotify: true,
    data: { url: n.navigate || n.url || './index.html', broadcastId: n.broadcastId || null },
    actions: [
      { action: 'ack', title: 'Acknowledge' },
      { action: 'open', title: 'Open Portal' }
    ]
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || './index.html', self.registration.scope).href;
  event.waitUntil((async () => {
    if (event.action === 'ack') {
      await notifyClients({ type: 'ACK_NOTIFICATION', broadcastId: data.broadcastId || null });
      return;
    }
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(target); } catch (e) { /* ignore */ } }
        return;
      }
    }
    await self.clients.openWindow(target);
  })());
});
