// Minimaler IndexedDB-Wrapper. Alles bleibt lokal im Browser/auf dem Gerät.
const DB_NAME = 'bibelstudium';
const DB_VERSION = 1;
const STORES = ['notes', 'marks', 'bibles', 'kv'];

let dbPromise = null;

function openOnce() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) {
          db.createObjectStore(s, s === 'kv' ? undefined : { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Datenbank öffnen. iOS lässt das Öffnen nach dem Aufwachen der App manchmal einfach hängen –
 * dann nach kurzer Zeit erneut versuchen statt ewig zu warten.
 */
function open() {
  if (dbPromise) return dbPromise;
  const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms));
  dbPromise = (async () => {
    let last;
    for (const ms of [2500, 4000, 8000]) {
      try {
        return await Promise.race([openOnce(), timeout(ms)]);
      } catch (e) {
        last = e;
      }
    }
    throw last;
  })();
  dbPromise.catch(() => (dbPromise = null)); // beim nächsten Zugriff neu versuchen
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const result = fn(s);
        t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const db = {
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  put: (store, value, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
};

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
