// Offline-Unterstützung mit „ganzen“ Updates:
// Eine neue Version wird beim Installieren komplett heruntergeladen (am Browser-Cache vorbei)
// und erst dann aktiviert. So können nie Dateien aus verschiedenen Versionen gemischt werden.
const VERSION = 'bibelstudium-v37';
const DATA_CACHE = 'bibelstudium-daten'; // Bibeltexte, Querverweise, PDF-Leser – ändern sich nie
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-180.png',
  'js/app.js',
  'js/bible.js',
  'js/books.js',
  'js/db.js',
  'js/notes.js',
  'js/translations.js',
  'js/util.js',
  'js/pdfimport.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) =>
        Promise.all(
          SHELL.map((url) =>
            fetch(url, { cache: 'reload' }).then((res) => {
              if (!res.ok) throw new Error(`${url}: ${res.status}`);
              return c.put(url, res);
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    (async () => {
      const old = (await caches.keys()).filter((k) => k !== VERSION && k !== DATA_CACHE);
      await Promise.all(old.map((k) => caches.delete(k)));
      await self.clients.claim();
      // Selbstheilung bei einem Update: offene Fenster – auch eine hängende alte Version – neu laden
      if (old.length) {
        const list = await self.clients.matchAll({ type: 'window' });
        await Promise.all(list.map((c) => c.navigate(c.url).catch(() => {})));
      }
    })()
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  // Bibeltexte, Querverweise, PDF-Leser: aus dem Datenspeicher (bleibt über Updates erhalten)
  if (url.pathname.includes('/data/') || url.pathname.includes('/vendor/')) {
    e.respondWith(
      caches.open(DATA_CACHE).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }

  // App-Dateien: immer aus der vollständig installierten Version
  e.respondWith(
    caches.open(VERSION).then(async (c) => {
      const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
      const hit = await c.match(key, { ignoreSearch: true });
      if (hit) return hit;
      try {
        return await fetch(e.request);
      } catch {
        return (await c.match('index.html')) || Response.error();
      }
    })
  );
});
