export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const COLORS = [
  { id: 'yellow', name: 'Gelb', hex: '#e8c26e' },
  { id: 'green', name: 'Grün', hex: '#6cd28c' },
  { id: 'blue', name: 'Blau', hex: '#6eaaff' },
  { id: 'pink', name: 'Rosa', hex: '#ff78b4' },
  { id: 'purple', name: 'Lila', hex: '#aa82ff' },
  { id: 'orange', name: 'Orange', hex: '#ff9650' },
];

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.flush = (...args) => {
    clearTimeout(t);
    fn(...(args.length ? args : [true]));
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/** Lokales Datum als Schlüssel "2026-11-08" */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Heute", "Gestern" oder z. B. "Fr., 6. Nov." (lang: "Freitag, 6. November") */
export function dayLabel(key, long = false) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (key === dayKey()) return 'Heute';
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (key === dayKey(yest)) return 'Gestern';
  const opts = long
    ? { weekday: 'long', day: 'numeric', month: 'long' }
    : { weekday: 'short', day: 'numeric', month: 'short' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString('de-DE', opts);
}

export function formatDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return 'Heute, ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Gestern, ' + d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Stelle des Cursors an einer Bildschirmkoordinate (für Drag & Drop) */
export function caretRangeAt(x, y) {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = document.createRange();
    r.setStart(p.offsetNode, p.offset);
    r.collapse(true);
    return r;
  }
  return null;
}
