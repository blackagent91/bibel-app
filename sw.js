// Offline-Unterstützung: App-Dateien und Bibeltexte werden zwischengespeichert.
const VERSION = 'bibelstudium-v15';
const SHELL = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/bible.js', 'js/books.js', 'js/db.js', 'js/notes.js', 'js/translations.js', 'js/util.js', 'js/pdfimport.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Bibeltexte: Cache zuerst (ändern sich nie)
  if (url.pathname.includes('/data/')) {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }
  // App-Dateien: Netzwerk zuerst, offline aus dem Cache
  // immer beim Server nachfragen (sonst liefert der Browser-Cache bis zu 10 Minuten alte Dateien)
  e.respondWith(
    fetch(e.request.mode === 'navigate' ? e.request : new Request(e.request, { cache: 'no-cache' }))
      .then((res) => {
        if (res.ok) caches.open(VERSION).then((c) => c.put(e.request, res.clone()));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
