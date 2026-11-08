// Bibelstudium – Hauptlogik: Daten, Verzeichnis, Drag & Drop, Einstellungen
import { db, uid } from './db.js';
import { BOOKS, getBook, formatRef, compareRefs } from './books.js';
import { loadImported, listTranslations, getTranslation, importBibleFile, deleteImported } from './translations.js';
import { BibleView } from './bible.js';
import { NotesEditor, unpackStrokes, titleFromRefs } from './notes.js';
import { $, $$, esc, toast, formatDate, dayKey, dayLabel } from './util.js';

// ---------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------
const state = {
  notes: new Map(), // id -> note
  marks: [], // einfache Markierungen ohne Notiz: {id, book, chapter, vs, ve, color}
  current: null, // aktuell geöffnete Notiz
  drawerTab: 'notes',
  dayFilter: null, // "2026-11-08" oder null = alle Tage
  bookFilter: null, // Buch-ID oder null = alle Bücher
  filterMode: 'day', // welche Filterleiste gerade sichtbar ist
  focus: null, // Vollbild: 'notes' | 'bible' | null (geteilt)
};

/** Tage, an denen an einer Notiz gearbeitet wurde */
const noteDays = (n) => n.days || [...new Set([dayKey(n.created), dayKey(n.updated)])];
/** Tag, an dem eine Bibelstelle markiert/eingefügt wurde */
const refDay = (r, n) => dayKey(r.added || r.created || n?.created || Date.now());

export const APP_VERSION = '48 · 08.11.2026';
const DEFAULTS = { bibleSize: 19, noteSize: 17, layout: 'lines', font: 'serif', trans: 'elb1905', split: 50, xrefs: 'on', swap: '0', headings: 'on' };
const settings = { ...DEFAULTS, ...readLS('settings', {}) };

function readLS(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
const saveSettings = () => writeLS('settings', settings);

const isEmpty = (n) => !n.title && !n.text && !(n.ink?.meta?.length || n.strokes?.length) && !(n.refs && n.refs.length);

function newNote(title = '') {
  const now = Date.now();
  return { id: uid('n_'), title, html: '', text: '', refs: [], strokes: [], created: now, updated: now };
}

// ---------------------------------------------------------------------------
// Markierungen für die Bibelansicht
// ---------------------------------------------------------------------------
function marksFor(book, chapter) {
  const out = [];
  for (const m of state.marks) if (m.book === book && m.chapter === chapter) out.push({ ...m });
  for (const n of state.notes.values()) {
    for (const r of n.refs || []) {
      if (r.book === book && r.chapter === chapter) {
        out.push({ vs: r.vs, ve: r.ve, color: r.color, noteId: n.id, noteTitle: n.title || 'Unbenannte Notiz' });
      }
    }
  }
  return out;
}

function chaptersWithNotes(book) {
  const set = new Set();
  for (const m of state.marks) if (m.book === book) set.add(m.chapter);
  for (const n of state.notes.values()) for (const r of n.refs || []) if (r.book === book) set.add(r.chapter);
  return set;
}

async function setHighlight(sel, color) {
  // vorhandene Markierungen im Bereich aufteilen / entfernen
  const next = [];
  const removed = [];
  for (const m of state.marks) {
    if (m.book !== sel.book || m.chapter !== sel.chapter || m.ve < sel.vs || m.vs > sel.ve) {
      next.push(m);
      continue;
    }
    removed.push(m);
    if (m.vs < sel.vs) next.push({ ...m, id: uid('m_'), ve: sel.vs - 1 });
    if (m.ve > sel.ve) next.push({ ...m, id: uid('m_'), vs: sel.ve + 1 });
  }
  if (color !== 'none') next.push({ id: uid('m_'), book: sel.book, chapter: sel.chapter, vs: sel.vs, ve: sel.ve, color, created: Date.now() });
  const keep = new Set(next.map((m) => m.id));
  for (const m of removed) if (!keep.has(m.id)) await db.del('marks', m.id);
  for (const m of next) if (!state.marks.includes(m)) await db.put('marks', m);
  state.marks = next;
  bible.applyMarks();
  if (color === 'none') {
    const linked = marksFor(sel.book, sel.chapter).some((m) => m.noteId && m.ve >= sel.vs && m.vs <= sel.ve);
    toast(linked ? 'Markierung entfernt. Stellen mit Notiz bleiben markiert, solange der Block in der Notiz ist.' : 'Markierung entfernt');
  }
  renderDrawer();
}

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------
const refSigs = new Map(); // Notiz-ID -> Bibelstellen beim letzten Speichern

async function persistNote(n) {
  const sig = JSON.stringify(n.refs || []) + '|' + (n.title || '');
  const refsChanged = refSigs.get(n.id) !== sig;
  refSigs.set(n.id, sig);
  if (isEmpty(n)) {
    if (state.notes.has(n.id)) {
      state.notes.delete(n.id);
      await db.del('notes', n.id);
      toast('Notiz war leer und wurde entfernt');
    }
  } else {
    state.notes.set(n.id, n);
    await db.put('notes', n);
  }
  writeLS('lastNote', n.id);
  if (refsChanged) bible.applyMarks();
  renderDrawer();
}

function openNote(id, { jump = true } = {}) {
  const n = state.notes.get(id);
  if (!n) return;
  state.current = n;
  editor.load(n);
  writeLS('lastNote', id);
  closeDrawer();
  showPane('notes');
  if (jump && n.refs?.length) bible.goto(n.refs[0]);
  renderDrawer();
}

function createNote(title = '') {
  editor.save.flush();
  const n = newNote(title);
  state.current = n;
  editor.load(n);
  renderDrawer();
  return n;
}

async function deleteNote(id) {
  const n = state.notes.get(id);
  if (!n) return;
  if (!confirm(`Notiz „${n.title || 'Unbenannt'}“ wirklich löschen?`)) return;
  state.notes.delete(id);
  await db.del('notes', id);
  if (state.current?.id === id) {
    const latest = sortedNotes()[0];
    if (latest) {
      state.current = latest;
      editor.load(latest);
    } else createNote();
  }
  bible.applyMarks();
  renderDrawer();
  toast('Notiz gelöscht');
}

/** Einfache Markierung (ohne Notiz) löschen */
async function deleteMark(id) {
  state.marks = state.marks.filter((m) => m.id !== id);
  await db.del('marks', id);
  bible.applyMarks();
  renderDrawer();
  toast('Markierung gelöscht');
}

/** Bibelstelle aus einer Notiz entfernen (der übrige Inhalt der Notiz bleibt) */
async function deleteNoteRef(noteId, idx) {
  const n = state.notes.get(noteId);
  const ref = n?.refs?.[idx];
  if (!ref) return;
  if (!confirm(`${formatRef(ref)} aus der Notiz „${n.title || 'Unbenannte Notiz'}“ entfernen?`)) return;
  if (state.current?.id === noteId) {
    // Notiz ist geöffnet: direkt im Editor entfernen (Rückgängig möglich)
    const block = editor.el.editor.querySelectorAll('.scripture')[idx];
    if (block) editor.removeScripture(block);
  } else {
    const tpl = document.createElement('template');
    tpl.innerHTML = n.html || '';
    tpl.content.querySelectorAll('.scripture')[idx]?.remove();
    n.html = tpl.innerHTML;
    const oldRefs = n.refs;
    n.refs = n.refs.filter((_, i) => i !== idx);
    const auto = n.autoTitle !== undefined ? n.title === n.autoTitle : !!n.title && n.title === titleFromRefs(oldRefs);
    if (auto) n.title = n.autoTitle = titleFromRefs(n.refs);
    n.updated = Date.now();
    await persistNote(n);
    toast('Bibelstelle aus der Notiz entfernt');
  }
  bible.applyMarks();
  renderDrawer();
}

const sortedNotes = () => [...state.notes.values()].sort((a, b) => b.updated - a.updated);

// ---------------------------------------------------------------------------
// Aktionen aus der Bibel
// ---------------------------------------------------------------------------
function handleBibleAction(sel, act, extra) {
  const parts = sel.parts || [sel];
  if (act === 'highlight') {
    bible.clearSelection();
    return (async () => {
      for (const p of parts) await setHighlight(p, extra);
    })();
  }
  if (act === 'new') {
    if (state.focus === 'bible') setFocus(null);
    const n = createNote(sel.label || formatRef(sel));
    n.autoTitle = n.title; // Überschrift passt sich den Bibelstellen an, bis man sie selbst ändert
    for (const p of parts) editor.insertScripture(p, { color: 'yellow' });
    bible.clearSelection();
    showPane('notes');
    toast(`Notiz „${n.title}“ erstellt`);
    return;
  }
  if (act === 'add') {
    for (const p of parts) editor.insertScripture(p, { color: 'yellow' });
    bible.clearSelection();
    toast(`${sel.label || formatRef(sel)} → „${state.current.title || 'Notiz'}“`);
    return;
  }
  if (act === 'drag') startDrag(sel, extra);
}

/** Eigene Drag-&-Drop-Logik (funktioniert mit Maus, Finger und Apple Pencil) */
function startDrag(sel, downEvent) {
  const ghost = $('#drag-ghost');
  ghost.innerHTML = `<b>${esc(sel.label || formatRef(sel))}</b><span>${esc(sel.verses.map((v) => v.t).join(' '))}</span>`;
  ghost.classList.remove('hidden');
  document.body.classList.add('dragging-ref');
  const move = (x, y) => {
    ghost.style.left = `${x}px`;
    ghost.style.top = `${y}px`;
    if (editor.isOverEditor(x, y)) editor.showDropHint(x, y);
    else editor.hideDropHint();
  };
  move(downEvent.clientX, downEvent.clientY);
  const onMove = (e) => {
    e.preventDefault();
    move(e.clientX, e.clientY);
  };
  const onUp = (e) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    ghost.classList.add('hidden');
    document.body.classList.remove('dragging-ref');
    editor.hideDropHint();
    if (e.type === 'pointerup' && editor.isOverEditor(e.clientX, e.clientY)) dropScripture(sel, e.clientX, e.clientY);
  };
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function dropScripture(sel, x, y) {
  if (editor.mode !== 'text') editor.setMode('text');
  // mehrere Abschnitte: in Bibelreihenfolge untereinander ablegen
  const parts = sel.parts || [sel];
  let block = null;
  for (const p of parts) {
    block = block ? editor.insertScriptureAfter(block, p, { color: 'yellow' }) : editor.insertScripture(p, { x, y, color: 'yellow' });
  }
  bible.clearSelection();
  toast(`${sel.label || formatRef(sel)} in Notiz abgelegt`);
}

// ---------------------------------------------------------------------------
// Notizverzeichnis
// ---------------------------------------------------------------------------
const drawer = $('#drawer');
function openDrawer() {
  editor.save.flush();
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  // Im Notizen-Vollbild als Seitenleiste neben der Notiz (die Notiz bleibt sichtbar)
  app.classList.toggle('drawer-docked', state.focus === 'notes');
  renderDrawer();
}
function closeDrawer({ force = false } = {}) {
  if (!force && app.classList.contains('drawer-docked')) return; // Seitenleiste bleibt offen, bis man sie schließt
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  app.classList.remove('drawer-docked');
}

/** Erste Bibelstelle einer Notiz in einem bestimmten Buch (für die Sortierung beim Buchfilter) */
const firstRefIn = (n, book) => (n.refs || []).filter((r) => r.book === book).sort(compareRefs)[0];

function renderFilters() {
  const notesTab = state.drawerTab === 'notes';
  // Zählen: Tage und Bücher (jeweils unter Berücksichtigung des anderen Filters)
  const dayCounts = new Map();
  const bookCounts = new Map();
  const inc = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  if (notesTab) {
    for (const n of state.notes.values()) {
      const books = new Set((n.refs || []).map((r) => r.book));
      if (!state.bookFilter || books.has(state.bookFilter)) for (const d of noteDays(n)) inc(dayCounts, d);
      if (!state.dayFilter || noteDays(n).includes(state.dayFilter)) for (const b of books) inc(bookCounts, b);
    }
  } else {
    const all = [];
    for (const n of state.notes.values()) for (const r of n.refs || []) all.push({ book: r.book, day: refDay(r, n) });
    for (const m of state.marks) all.push({ book: m.book, day: refDay(m) });
    for (const r of all) {
      if (!state.bookFilter || r.book === state.bookFilter) inc(dayCounts, r.day);
      if (!state.dayFilter || r.day === state.dayFilter) inc(bookCounts, r.book);
    }
  }
  const days = [...dayCounts.keys()].sort().reverse();
  const books = [...bookCounts.keys()].sort((x, y) => x - y);
  const bar = $('#day-filter');
  if (days.length < 2 && !books.length && !state.dayFilter && !state.bookFilter) {
    bar.innerHTML = '';
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const mode = state.filterMode;
  const seg = `<div class="seg">
      <button class="${mode === 'day' ? 'active' : ''}" data-mode="day">Tage</button>
      <button class="${mode === 'book' ? 'active' : ''}" data-mode="book">Bücher</button>
    </div>`;
  const chip = (attr, key, active, label, n) =>
    `<button class="chip${active ? ' active' : ''}" data-${attr}="${key ?? ''}">${esc(label)}${n != null ? ` <em>${n}</em>` : ''}</button>`;
  // aktiver Filter der anderen Art als entfernbares Kärtchen
  let other = '';
  if (mode === 'book' && state.dayFilter) other = `<button class="chip active" data-clear="day">${esc(dayLabel(state.dayFilter))} ✕</button>`;
  if (mode === 'day' && state.bookFilter) other = `<button class="chip active" data-clear="book">${esc(getBook(state.bookFilter).name)} ✕</button>`;
  const chips =
    mode === 'day'
      ? chip('day', '', !state.dayFilter, 'Alle Tage') + days.map((d) => chip('day', d, state.dayFilter === d, dayLabel(d), dayCounts.get(d))).join('')
      : chip('book', '', !state.bookFilter, 'Alle Bücher') +
        books.map((b) => chip('book', b, state.bookFilter === b, getBook(b).name, bookCounts.get(b))).join('');
  bar.innerHTML = seg + other + chips;
}

function renderDrawer() {
  updateFocusCount();
  if (!drawer.classList.contains('open')) return;
  renderFilters();
  const q = $('#drawer-search').value.trim().toLowerCase();
  const list = $('#drawer-list');
  if (state.drawerTab === 'notes') {
    const notes = sortedNotes().filter((n) => {
      if (state.dayFilter && !noteDays(n).includes(state.dayFilter)) return false;
      if (state.bookFilter && !(n.refs || []).some((r) => r.book === state.bookFilter)) return false;
      if (!q) return true;
      const hay = `${n.title} ${n.text} ${(n.refs || []).map((r) => formatRef(r) + ' ' + formatRef(r, true)).join(' ')}`.toLowerCase();
      return hay.includes(q);
    });
    if (!notes.length) {
      list.innerHTML = `<div class="empty">${q || state.dayFilter || state.bookFilter ? 'Keine Notiz gefunden.' : 'Noch keine Notizen.<br>Markiere eine Bibelstelle und tippe auf „Notiz erstellen“.'}</div>`;
      return;
    }
    // Buchfilter: zum Durchgehen in Bibelreihenfolge statt nach Datum
    if (state.bookFilter) notes.sort((x, y) => compareRefs(firstRefIn(x, state.bookFilter), firstRefIn(y, state.bookFilter)));
    let lastDay = null;
    let lastChapter = null;
    list.innerHTML = notes
      .map((n) => {
        // ohne Tagesfilter: Überschrift je Tag der letzten Bearbeitung
        let head = '';
        const d = dayKey(n.updated);
        if (state.bookFilter) {
          const ch = firstRefIn(n, state.bookFilter).chapter;
          if (ch !== lastChapter) {
            head = `<h5 class="day-head">${esc(getBook(state.bookFilter).name)} · Kapitel ${ch}</h5>`;
            lastChapter = ch;
          }
        } else if (!state.dayFilter && d !== lastDay) {
          head = `<h5 class="day-head">${esc(dayLabel(d, true))}</h5>`;
          lastDay = d;
        }
        const refs = (n.refs || [])
          .map((r, i) => `<button class="chip" data-note="${n.id}" data-ref-idx="${i}"><i style="background:var(--c-${r.color || 'yellow'})"></i>${esc(formatRef(r, true))}</button>`)
          .join('');
        return `${head}<div class="note-item${state.current?.id === n.id ? ' active' : ''}" data-open="${n.id}">
          <h4>${esc(n.title || 'Unbenannte Notiz')}</h4>
          ${refs ? `<div class="chips">${refs}</div>` : ''}
          ${n.text ? `<p>${esc(n.text.slice(0, 160))}</p>` : ''}
          <time>${formatDate(n.updated)}</time>
          <button class="icon-btn del" data-del="${n.id}" title="Löschen" aria-label="Löschen"><svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg></button>
        </div>`;
      })
      .join('');
  } else {
    // Alle markierten Stellen in Bibelreihenfolge
    const items = [];
    for (const n of state.notes.values()) (n.refs || []).forEach((r, idx) => items.push({ ...r, day: refDay(r, n), noteId: n.id, refIdx: idx, label: n.title || 'Unbenannte Notiz' }));
    for (const m of state.marks) items.push({ ...m, day: refDay(m), markId: m.id, label: 'Nur markiert' });
    const filtered = items
      .filter((r) => !state.dayFilter || r.day === state.dayFilter)
      .filter((r) => !state.bookFilter || r.book === state.bookFilter)
      .filter((r) => !q || `${formatRef(r)} ${formatRef(r, true)} ${r.label}`.toLowerCase().includes(q))
      .sort(compareRefs);
    if (!filtered.length) {
      list.innerHTML = `<div class="empty">${q || state.dayFilter || state.bookFilter ? 'Nichts gefunden.' : 'Noch keine markierten Bibelstellen.'}</div>`;
      return;
    }
    let html = '';
    let lastBook = 0;
    for (const r of filtered) {
      if (r.book !== lastBook) {
        if (lastBook) html += '</div>';
        html += `<div class="ref-group"><h5>${esc(getBook(r.book).name)}</h5>`;
        lastBook = r.book;
      }
      const delAttr = r.noteId ? `data-del-note="${r.noteId}" data-del-idx="${r.refIdx}"` : `data-del-mark="${r.markId}"`;
      html += `<div class="ref-item" data-goto="${r.book}:${r.chapter}:${r.vs}:${r.ve}" ${r.noteId ? `data-note="${r.noteId}"` : ''}>
        <i style="background:var(--c-${r.color || 'yellow'})"></i>
        <div class="ref-item-text"><b>${esc(formatRef(r))}</b><span>${esc(r.label)}</span></div>
        <button class="icon-btn ref-del" ${delAttr} title="Löschen" aria-label="Bibelstelle löschen"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>`;
    }
    list.innerHTML = html + '</div>';
  }
}

function bindDrawer() {
  $('#btn-index').onclick = openDrawer;
  $('#drawer-close').onclick = () => closeDrawer({ force: true });
  $('#drawer-scrim').onclick = () => closeDrawer({ force: true });
  $('#drawer-new').onclick = () => {
    createNote();
    closeDrawer();
  };
  $('#drawer-search').addEventListener('input', renderDrawer);
  $('#day-filter').addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.mode) state.filterMode = t.dataset.mode;
    else if ('day' in t.dataset) state.dayFilter = t.dataset.day || null;
    else if ('book' in t.dataset) state.bookFilter = t.dataset.book ? +t.dataset.book : null;
    else if (t.dataset.clear === 'day') state.dayFilter = null;
    else if (t.dataset.clear === 'book') state.bookFilter = null;
    renderDrawer();
    $('#drawer-list').scrollTop = 0;
  });
  $$('#drawer .tab').forEach(
    (t) =>
      (t.onclick = () => {
        state.drawerTab = t.dataset.tab;
        $$('#drawer .tab').forEach((x) => x.classList.toggle('active', x === t));
        $('#drawer-search').placeholder = t.dataset.tab === 'notes' ? 'Notizen durchsuchen …' : 'Bibelstellen durchsuchen …';
        renderDrawer();
      })
  );
  $('#drawer-list').addEventListener('click', (e) => {
    const refDel = e.target.closest('.ref-del');
    if (refDel) {
      e.stopPropagation();
      if (refDel.dataset.delMark) return deleteMark(refDel.dataset.delMark);
      return deleteNoteRef(refDel.dataset.delNote, +refDel.dataset.delIdx);
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      return deleteNote(del.dataset.del);
    }
    const chip = e.target.closest('[data-ref-idx]');
    if (chip) {
      e.stopPropagation();
      const n = state.notes.get(chip.dataset.note);
      openNote(n.id, { jump: false });
      bible.goto(n.refs[+chip.dataset.refIdx]);
      showPane(isNarrow() ? 'bible' : 'notes');
      return;
    }
    const go = e.target.closest('[data-goto]');
    if (go) {
      const [book, chapter, vs, ve] = go.dataset.goto.split(':').map(Number);
      if (go.dataset.note) openNote(go.dataset.note, { jump: false });
      else closeDrawer();
      bible.goto({ book, chapter, vs, ve });
      if (isNarrow()) showPane('bible');
      return;
    }
    const item = e.target.closest('[data-open]');
    if (item) openNote(item.dataset.open);
  });
}

// ---------------------------------------------------------------------------
// Layout: Trenner, Mobil-Tabs
// ---------------------------------------------------------------------------
const app = $('#app');
const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;

function showPane(which) {
  app.dataset.show = which;
  $$('#mobile-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.show === which));
}

function bindLayout() {
  app.style.setProperty('--split', `${settings.split}%`);
  const div = $('#divider');
  div.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    div.setPointerCapture(e.pointerId);
    div.classList.add('dragging');
    document.body.classList.add('resizing'); // keine Textauswahl während des Ziehens
    window.getSelection()?.removeAllRanges();
    bible.clearSelection();
    const r = app.getBoundingClientRect();
    const x0 = e.clientX;
    const split0 = settings.split;
    const move = (ev) => {
      // relativ zur Startposition: die Spalte bewegt sich genau mit dem Finger, ohne Sprung
      const dx = ((ev.clientX - x0) / r.width) * 100 * (settings.swap === '1' ? -1 : 1);
      const pct = Math.min(75, Math.max(25, split0 + dx));
      settings.split = Math.round(pct * 10) / 10;
      app.style.setProperty('--split', `${settings.split}%`);
    };
    const up = () => {
      div.classList.remove('dragging');
      document.body.classList.remove('resizing');
      div.removeEventListener('pointermove', move);
      div.removeEventListener('pointerup', up);
      div.removeEventListener('pointercancel', up);
      saveSettings();
    };
    div.addEventListener('pointermove', move);
    div.addEventListener('pointerup', up);
    div.addEventListener('pointercancel', up);
  });
  // Vollbild-Knöpfe und Umschalter
  $$('.focus-btn').forEach((b) => (b.onclick = () => setFocus(state.focus === b.dataset.focus ? null : b.dataset.focus)));
  $('#focus-switch').onclick = () => setFocus(state.focus === 'notes' ? 'bible' : 'notes');
  $('#focus-prev').onclick = () => stepNote(-1);
  $('#focus-next').onclick = () => stepNote(1);
  window.matchMedia('(max-width: 760px)').addEventListener?.('change', () => state.focus && setFocus(null));

  // Seiten tauschen: Griff antippen oder zur Seite ziehen
  const swap = $('#swap-btn');
  swap.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation(); // nicht die Breite verstellen
    capture(swap, e.pointerId);
    swap.classList.add('active');
    const x0 = e.clientX;
    let done = false;
    const move = (ev) => {
      if (!done && Math.abs(ev.clientX - x0) > 50) {
        done = true;
        toggleSwap();
      }
    };
    const up = () => {
      swap.classList.remove('active');
      swap.removeEventListener('pointermove', move);
      swap.removeEventListener('pointerup', up);
      swap.removeEventListener('pointercancel', up);
      if (!done) toggleSwap(); // einfacher Tipp
    };
    swap.addEventListener('pointermove', move);
    swap.addEventListener('pointerup', up);
    swap.addEventListener('pointercancel', up);
  });
  div.addEventListener('dblclick', () => {
    settings.split = 50;
    app.style.setProperty('--split', '50%');
    saveSettings();
  });
  $('#mobile-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-show]');
    if (b) showPane(b.dataset.show);
  });
  showPane('notes');

  $$('.mode-btn').forEach((b) => (b.onclick = () => editor.setMode(b.dataset.mode)));
  $('#btn-new-note').onclick = () => {
    createNote();
  };
}

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------
function capture(el, id) {
  try {
    el.setPointerCapture(id);
  } catch {}
}

/** Vollbild für eine Seite (oder zurück zur geteilten Ansicht mit null) */
function setFocus(which) {
  if (isNarrow()) which = null; // auf dem Handy gibt es ohnehin nur eine Seite
  state.focus = which;
  // Verzeichnis: im Notizen-Vollbild als Seitenleiste, sonst wieder normal (darüber)
  if (drawer.classList.contains('open')) {
    if (which === 'notes') app.classList.add('drawer-docked');
    else closeDrawer({ force: true });
  }
  app.classList.toggle('focus-notes', which === 'notes');
  app.classList.toggle('focus-bible', which === 'bible');
  const bar = $('#focus-bar');
  bar.classList.toggle('hidden', !which);
  bar.classList.toggle('notes', which === 'notes');
  $('#focus-switch-label').textContent = which === 'notes' ? 'Zur Bibel' : 'Zu den Notizen';
  updateFocusCount();
  $$('.focus-btn').forEach((b) => {
    const on = state.focus === b.dataset.focus;
    b.title = on ? 'Vollbild beenden' : b.dataset.focus === 'notes' ? 'Notizen im Vollbild' : 'Bibel im Vollbild';
  });
  bible.positionMenu?.();
}

/** Im Notizen-Vollbild: „2 / 5“ anzeigen */
function updateFocusCount() {
  const el = $('#focus-count');
  if (!el) return;
  if (state.focus !== 'notes') return (el.textContent = '');
  const list = sortedNotes();
  const i = list.findIndex((n) => n.id === state.current?.id);
  el.textContent = list.length > 1 || i < 0 ? `${i < 0 ? '–' : i + 1} / ${list.length}` : '';
}

/** Im Notizen-Vollbild durch die Notizen blättern (Reihenfolge wie im Verzeichnis, am Ende wieder von vorn) */
function stepNote(dir) {
  editor.save.flush();
  const list = sortedNotes();
  if (!list.length) return toast('Noch keine Notizen');
  const i = list.findIndex((n) => n.id === state.current?.id);
  if (i >= 0 && list.length === 1) return toast('Das ist die einzige Notiz');
  const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  openNote(list[next].id);
  updateFocusCount();
}

function applySwap() {
  app.classList.toggle('swapped', settings.swap === '1');
}

function toggleSwap() {
  settings.swap = settings.swap === '1' ? '0' : '1';
  app.classList.add('swapping');
  setTimeout(() => {
    applySwap();
    app.classList.remove('swapping');
  }, 120);
  saveSettings();
  toast(settings.swap === '1' ? 'Notizen rechts · Bibel links' : 'Notizen links · Bibel rechts', 1600);
}

function applySettings() {
  applySwap();
  document.documentElement.style.setProperty('--bible-size', `${settings.bibleSize}px`);
  document.documentElement.style.setProperty('--note-size', `${settings.noteSize}px`);
  bible.setLayout(settings.layout, settings.font);
  if (bible.xrefMode !== settings.xrefs) bible.setXrefMode(settings.xrefs);
  bible.setShowHeadings(settings.headings !== 'off');
  $('#out-bible-size').textContent = settings.bibleSize;
  $('#out-note-size').textContent = settings.noteSize;
}

function renderTranslations() {
  const list = listTranslations();
  if (!list.some((t) => t.id === settings.trans)) settings.trans = 'elb1905';
  $('#translation').innerHTML = list
    .map((t) => `<option value="${t.id}"${t.id === settings.trans ? ' selected' : ''}>${esc(t.short)}</option>`)
    .join('');
  $('#trans-list').innerHTML = list
    .map(
      (t) => `<div class="trans-item"><div>${esc(t.name)}<small>${esc(t.note || '')}</small></div>
      ${t.builtin ? '' : `<button class="btn danger" data-del-trans="${t.id}">Entfernen</button>`}</div>`
    )
    .join('');
}

function bindSettings() {
  const modal = $('#settings');
  $('#btn-settings').onclick = () => {
    $('#app-version').textContent = `App-Version ${APP_VERSION}`;
    $('#set-bible-size').value = settings.bibleSize;
    $('#set-note-size').value = settings.noteSize;
    $('#set-layout').value = settings.layout;
    $('#set-font').value = settings.font;
    $('#set-xrefs').value = settings.xrefs;
    $('#set-swap').value = settings.swap;
    $('#set-headings').value = settings.headings;
    renderTranslations();
    modal.classList.remove('hidden');
  };
  modal.addEventListener('click', (e) => {
    if (e.target === modal || e.target.closest('[data-close]')) modal.classList.add('hidden');
  });
  const bindInput = (id, key, num = true) =>
    $(id).addEventListener('input', (e) => {
      settings[key] = num ? +e.target.value : e.target.value;
      applySettings();
      saveSettings();
    });
  bindInput('#set-bible-size', 'bibleSize');
  bindInput('#set-note-size', 'noteSize');
  bindInput('#set-layout', 'layout', false);
  bindInput('#set-font', 'font', false);
  bindInput('#set-xrefs', 'xrefs', false);
  bindInput('#set-swap', 'swap', false);
  bindInput('#set-headings', 'headings', false);

  $('#translation').addEventListener('change', async (e) => {
    settings.trans = e.target.value;
    saveSettings();
    await bible.setTranslation(settings.trans);
    toast(`Übersetzung: ${getTranslation(settings.trans).name}`);
  });

  $('#import-bible').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    $('#settings').classList.add('hidden');
    const modal = $('#import-modal');
    const signal = { cancelled: false };
    $('#import-title').textContent = 'Bibel wird importiert …';
    $('#import-progress').classList.remove('hidden');
    $('#import-result').classList.add('hidden');
    $('#import-status').textContent = `„${file.name}“ wird geöffnet …`;
    $('#import-bar').style.width = '0%';
    $('#import-cancel').onclick = () => {
      signal.cancelled = true;
    };
    modal.classList.remove('hidden');
    try {
      const res = await importBibleFile(file, {
        signal,
        onProgress: ({ page, pages, book, phase }) => {
          const pct = phase === 1 ? (page / pages) * 35 : phase === 2 ? 35 + (page / pages) * 65 : (page / pages) * 100;
          $('#import-bar').style.width = `${Math.round(pct)}%`;
          const step = phase === 1 ? 'Schritt 1 von 2 · Buchanfänge suchen' : phase === 2 ? 'Schritt 2 von 2 · Text einlesen' : '';
          $('#import-status').textContent = `${step ? step + ' · ' : ''}Seite ${page} von ${pages}${book ? ` · ${getBook(book).name}` : ''}`;
        },
        name: (suggested) => prompt('Wie soll die Übersetzung heißen?', suggested) || suggested,
      });
      settings.trans = res.id;
      saveSettings();
      renderTranslations();
      await bible.setTranslation(res.id);
      showImportResult(res);
    } catch (err) {
      console.error(err);
      modal.classList.add('hidden');
      toast(`Import fehlgeschlagen: ${err.message}`, 6000);
    }
  });

  function showImportResult(res) {
    const r = res.report;
    $('#import-title').textContent = `„${res.name}“ importiert`;
    $('#import-progress').classList.add('hidden');
    const box = $('#import-result');
    box.classList.remove('hidden');
    let html = '';
    if (r?.structured) {
      html += `<p class="report-ok">✓ ${res.verses.toLocaleString('de-DE')} Verse in allen Büchern und Kapiteln übernommen – die Datei bringt die Einteilung schon mit.</p>
        <p class="hint">Dazu ${r.headings.toLocaleString('de-DE')} Zwischenüberschriften und ${r.xrefs.toLocaleString('de-DE')} Querverweise.</p>`;
    } else if (r) {
      html += `<div class="report-stats">
        <div><b>${r.books}/66</b><span>Bücher</span></div>
        <div><b>${r.chapters.toLocaleString('de-DE')}</b><span>Kapitel</span></div>
        <div><b>${r.verses.toLocaleString('de-DE')}</b><span>Verse</span></div></div>`;
      if (r.xrefs) html += `<p class="hint">Dazu ${r.xrefs.toLocaleString('de-DE')} Parallelstellen aus den Zwischenüberschriften übernommen.</p>`;
      const issues = [
        ...(r.missingBooks.length ? [`Nicht gefunden: ${r.missingBooks.join(', ')}`] : []),
        ...r.chapterIssues,
      ];
      const extra = [...(r.fallbacks || []), ...(r.unmatched || []).map((u) => `Überschrift nicht zugeordnet – ${u}`)];
      const skipped = r.skipped || [];
      html += issues.length
        ? `<p class="hint">Folgendes konnte nicht vollständig erkannt werden – diese Stellen fehlen oder sind unvollständig:</p><div class="report-list">${issues.map(esc).join('<br>')}</div>`
        : `<p class="report-ok">✓ Alle Bücher und Kapitel wurden erkannt.</p>`;
      if (extra.length) html += `<p class="hint">Hinweise (für die Fehlersuche):</p><div class="report-list">${extra.map(esc).join('<br>')}</div>`;
      if (skipped.length) html += `<p class="hint">Übersprungen (Vorwort/Anhang, kein Bibeltext): ${skipped.length} Abschnitt${skipped.length > 1 ? 'e' : ''}</p>`;
      if (r.deviations?.length) {
        html += `<p class="hint">Abgleich mit der Vorlage (deutsche und Elberfelder-Verszählung) – ${r.deviations.length} Kapitel passen zu keiner von beiden. Tippe zum Prüfen:</p>
          <div class="report-list">${r.deviations
            .slice(0, 80)
            .map((d) => `<button class="dev-item" data-dev="${d.book}:${d.chapter}">${esc(getBook(d.book).name)} ${d.chapter}: ${d.exp ? `${d.got} statt ${d.exp} Verse` : `${d.got} Verse – Kapitel gibt es in der Vorlage nicht`}</button>`)
            .join('')}${r.deviations.length > 80 ? '<br>…' : ''}</div>`;
      } else if (r.books > 60) {
        html += `<p class="report-ok">✓ Alle Kapitel passen zur Vorlage.</p>`;
      }
      if (r.starts?.length) {
        html += `<details class="report-details"><summary>Gefundene Buchanfänge (${r.starts.length})</summary><div class="report-list">${r.starts.map(esc).join('<br>')}</div></details>`;
      }
      html += `<p class="hint">Stichprobe: Schau dir ein paar Kapitel an. Wenn irgendwo Überschriften oder Fußnoten im Text stehen, sag Bescheid.</p>`;
    } else {
      html += `<p class="report-ok">✓ ${res.verses.toLocaleString('de-DE')} Verse importiert.</p>`;
    }
    html += `<div class="row-btns"><button class="btn primary" id="import-done">Fertig</button></div>`;
    box.innerHTML = html;
    $('#import-done').onclick = () => $('#import-modal').classList.add('hidden');
    box.querySelectorAll('[data-dev]').forEach(
      (b) =>
        (b.onclick = () => {
          const [book, chapter] = b.dataset.dev.split(':').map(Number);
          $('#import-modal').classList.add('hidden');
          bible.goto({ book, chapter });
          if (isNarrow()) showPane('bible');
        })
    );
  }

  $('#trans-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-trans]');
    if (!b) return;
    if (!confirm('Diese importierte Übersetzung vom Gerät entfernen? Deine Notizen bleiben erhalten.')) return;
    await deleteImported(b.dataset.delTrans);
    if (settings.trans === b.dataset.delTrans) {
      settings.trans = 'elb1905';
      saveSettings();
      await bible.setTranslation('elb1905');
    }
    renderTranslations();
  });

  // Sicherung
  $('#repair-app').onclick = () => {
    editor.save.flush();
    toast('Wird neu geladen …');
    setTimeout(() => window.__repairApp?.(), 300);
  };

  $('#export-backup').onclick = async () => {
    editor.save.flush();
    const data = {
      app: 'bibelstudium',
      version: 1,
      exported: new Date().toISOString(),
      notes: [...state.notes.values()].map(({ ink, ...n }) => ({ ...n, strokes: unpackStrokes({ ink, strokes: n.strokes }) })),
      marks: state.marks,
      settings,
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `bibelstudium-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  $('#import-backup').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'bibelstudium') throw new Error('Keine Bibelstudium-Sicherung');
      if (!confirm(`${data.notes.length} Notizen und ${data.marks.length} Markierungen einspielen? Vorhandene Einträge mit gleicher ID werden überschrieben.`)) return;
      for (const n of data.notes) {
        state.notes.set(n.id, n);
        await db.put('notes', n);
      }
      for (const m of data.marks) {
        state.marks = state.marks.filter((x) => x.id !== m.id).concat(m);
        await db.put('marks', m);
      }
      bible.applyMarks();
      renderDrawer();
      toast('Sicherung eingespielt');
    } catch (err) {
      toast(`Fehler: ${err.message}`, 5000);
    }
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const editor = new NotesEditor({
  onSave: persistNote,
  onJump: (ref) => {
    if (state.focus === 'notes') setFocus(null);
    bible.goto(ref);
    if (isNarrow()) showPane('bible');
  },
  onDropScripture: (payload, x, y) => dropScripture(payload, x, y),
});

const bible = new BibleView({
  marksFor,
  chaptersWithNotes,
  onAction: handleBibleAction,
  onOpenNote: (id, opts) => openNote(id, opts),
  onNavigate: (pos) => writeLS('position', pos),
  getBibleSize: () => settings.bibleSize,
  onBibleSize: (px, final) => {
    settings.bibleSize = px;
    document.documentElement.style.setProperty('--bible-size', `${px}px`);
    if (final) {
      saveSettings();
      $('#out-bible-size').textContent = px;
      toast(`Schriftgröße Bibel: ${px}`, 1200);
    }
  },
  toast,
});

async function init() {
  bindLayout();
  bindDrawer();
  bindSettings();
  applySettings();

  try {
    const [notes, marks] = await Promise.all([db.all('notes'), db.all('marks'), loadImported()]);
    for (const n of notes) state.notes.set(n.id, n);
    state.marks = marks;
  } catch (e) {
    console.error(e);
    toast('Speicher nicht verfügbar – Notizen werden nicht dauerhaft gespeichert.', 6000);
  }
  renderTranslations();
  bible.trans = settings.trans;

  const last = state.notes.get(readLS('lastNote', null)) || sortedNotes()[0];
  if (last) {
    state.current = last;
    editor.load(last);
  } else createNote();

  const pos = readLS('position', { book: 1, chapter: 1 });
  await bible.goto(getBook(pos.book) ? pos : { book: 1, chapter: 1 }, { flash: false });

  window.addEventListener('beforeunload', () => editor.save.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') editor.save.flush();
  });

  window.__appReady = true; // Start geglückt – Notfall-Hinweis wird nicht gebraucht

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // Wenn eine neue Version komplett installiert ist, einmal neu laden – so laufen nie zwei Versionen gemischt
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloading) return;
      reloading = true;
      editor.save.flush();
      location.reload();
    });
    navigator.serviceWorker
      .register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        reg.update();
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch(() => {});
  }
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}

init();

// Für Fehlersuche in der Konsole
window.bibelstudium = { state, settings, bible, editor, BOOKS };
