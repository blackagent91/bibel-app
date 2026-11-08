// Linke Seite: Notiz-Editor (Text + Blöcke) und Zeichenebene für Apple Pencil
import { formatRef } from './books.js';
import { $, $$, esc, COLORS, debounce, toast, dayKey, caretRangeAt } from './util.js';

const TEXT_COLORS = ['#f2f2f2', '#b4b4ba', '#e8c26e', '#6cd28c', '#6eaaff', '#ff78b4', '#aa82ff', '#ff9650', '#ff6b6b'];
const HILITE = {
  yellow: 'rgba(232,194,110,.38)',
  green: 'rgba(108,210,140,.34)',
  blue: 'rgba(110,170,255,.36)',
  pink: 'rgba(255,120,180,.34)',
  purple: 'rgba(170,130,255,.36)',
  orange: 'rgba(255,150,80,.36)',
};
const BLOCK_COLORS = [
  { id: 'gray', name: 'Grau', hex: '#3a3a40' },
  { id: 'yellow', name: 'Gelb', hex: '#e8c26e' },
  { id: 'green', name: 'Grün', hex: '#6cd28c' },
  { id: 'blue', name: 'Blau', hex: '#6eaaff' },
  { id: 'pink', name: 'Rosa', hex: '#ff78b4' },
  { id: 'purple', name: 'Lila', hex: '#aa82ff' },
];
const PEN_COLORS = ['#f2f2f2', '#e8c26e', '#6cd28c', '#6eaaff', '#ff78b4', '#aa82ff', '#ff6b6b', '#8a8a92'];
const PEN_WIDTHS = [1.5, 2.5, 4, 7];
const PALM_GRACE_MS = 900; // so lange nach dem Stift werden Berührungen der Hand ignoriert
const MIN_VERTICAL_REVERSALS = 6; // ab 3 Bögen (Ab-Auf-Ab-Auf…) gilt Hoch-runter-Kritzeln als Löschen
const MIN_HORIZONTAL_REVERSALS = 3;
const FADE_MS = 380;
const PALM_SIZE = 40;
const PAGE_W = 640; // feste Seitenbreite der Notiz (logische Pixel), wird auf die Spaltenbreite skaliert
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.35;
const MOVE_HOLD_MS = 500; // so lange auf einer Form halten, um sie zu verschieben
const HOLD_MS = 550; // so lange den Stift ruhig halten, damit eine Form einrastet
const AUTO_SHAPE_SIZE = 75;
const LINE_AUTO_SIZE = 50; // gerade Linien schon ab ~1,3 cm automatisch (Unterstreichen) // ab dieser Größe (px Diagonale) werden Formen automatisch erkannt // Kontaktfläche (px), ab der eine Berührung als Handballen gilt

/** HTML eines Bibelstellen-Blocks */
export function scriptureHTML(p, color = 'yellow') {
  const ref = { book: p.book, chapter: p.chapter, vs: p.vs, ve: p.ve };
  const verses = (p.verses || []).map((v) => `<sup>${v.n}</sup>${esc(v.t)}`).join(' ');
  return (
    `<div class="scripture" contenteditable="false" data-color="${color}" data-added="${Date.now()}" data-ref='${JSON.stringify(ref)}'>` +
    `<button class="scripture-grip" type="button" contenteditable="false" aria-label="Bibelstelle verschieben" title="Gedrückt halten und ziehen zum Verschieben"><svg viewBox="0 0 24 24"><g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></g></svg></button>` +
    `<button class="scripture-ref" type="button">${esc(formatRef(ref))}<span class="scripture-trans">${esc(p.transShort || '')}</span></button>` +
    `<button class="scripture-toggle" type="button" contenteditable="false" aria-label="Text auf- oder zuklappen"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button><button class="scripture-remove" type="button" contenteditable="false" aria-label="Bibelstelle entfernen" title="Entfernen"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>` +
    `<div class="scripture-text">${verses}</div></div>`
  );
}

export class NotesEditor {
  constructor({ onSave, onJump, onDropScripture }) {
    this.onSave = onSave;
    this.onJump = onJump;
    this.onDropScripture = onDropScripture;
    this.note = null;
    this.mode = 'text';
    this.lastRange = null;

    this.el = {
      body: $('#note-body'),
      scroll: $('#note-scroll'),
      page: $('#note-page'),
      title: $('#note-title'),
      meta: $('#note-meta'),
      editor: $('#editor'),
      handle: $('#block-handle'),
      dropHint: $('#drop-hint'),
      saveState: $('#save-state'),
    };
    this.save = debounce((flushed) => this.commit(flushed === true), 500);
    this.saveInk = debounce((flushed) => this.commit(flushed === true), 1500);
    this.hist = [''];
    this.hIdx = 0;
    this.recordSoon = debounce(() => this.record(), 600);
    this.ink = new Ink(this);
    this.bindEditor();
    this.bindToolbar();
    this.bindBlocks();
    this.bindDrop();
    this.bindUndo();
    this.bindPaper();
  }

  // ------------------------------------------------------------------ Papier (leer/Punkte/Kästchen/Linien)
  bindPaper() {
    const sw = $('#paper-switch');
    sw.addEventListener('pointerdown', (e) => e.preventDefault()); // Fokus/Auswahl im Editor behalten
    sw.addEventListener('click', (e) => {
      const b = e.target.closest('[data-paper]');
      if (!b || !this.note) return;
      const paper = b.dataset.paper;
      this.applyPaper(paper);
      try { localStorage.setItem('paper', paper); } catch {}
      if (this.note.paper !== paper) {
        this.note.paper = paper;
        this.changed();
      }
    });
  }

  applyPaper(paper) {
    this.el.page.dataset.paper = paper;
    $$('#paper-switch [data-paper]').forEach((b) => b.classList.toggle('active', b.dataset.paper === paper));
  }

  // ------------------------------------------------------------------ Rückgängig: Knöpfe + Gesten
  bindUndo() {
    for (const [id, fn] of [['#btn-undo', () => this.undo()], ['#btn-redo', () => this.redo()]]) {
      const b = $(id);
      b.addEventListener('pointerdown', (e) => e.preventDefault()); // Fokus/Auswahl im Editor behalten
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', fn);
    }
    // Tipp mit 2 Fingern = Rückgängig, mit 3 Fingern = Wiederholen (wie in Notiz-Apps)
    const body = this.el.body;
    let tap = null;
    const fingers = (list) => [...list].filter((t) => t.touchType !== 'stylus');
    body.addEventListener('touchstart', (e) => {
      const f = fingers(e.touches);
      if (f.length !== e.touches.length || this.ink.penActive()) { tap = null; return; }
      if (f.length >= 2) {
        if (!tap) tap = { t: Date.now(), max: 0, pts: new Map() };
        for (const t of f) if (!tap.pts.has(t.identifier)) tap.pts.set(t.identifier, [t.clientX, t.clientY]);
        tap.max = Math.max(tap.max, f.length);
      }
    }, { passive: true });
    body.addEventListener('touchmove', (e) => {
      if (!tap) return;
      for (const t of e.touches) {
        const start = tap.pts.get(t.identifier);
        if (start && Math.hypot(t.clientX - start[0], t.clientY - start[1]) > 14) { tap = null; return; }
      }
    }, { passive: true });
    body.addEventListener('touchend', (e) => {
      if (!tap || e.touches.length) return;
      const ok = Date.now() - tap.t < 400 && !this.ink.penActive();
      const n = tap.max;
      tap = null;
      if (!ok) return;
      if (n === 2) this.undo();
      else if (n >= 3) this.redo();
    }, { passive: true });
    body.addEventListener('touchcancel', () => (tap = null), { passive: true });
  }

  // ------------------------------------------------------------------ Laden / Speichern
  load(note) {
    if (this.note && this.note.id !== note?.id) this.save.flush();
    this.note = note;
    this.dirty = false;
    this.dirtyText = false;
    this.dirtyInk = false;
    this.saveInk.cancel();
    this.el.title.value = note?.title || '';
    this.applyPaper(note?.paper || readPaper());
    this.el.editor.innerHTML = note?.html || '';
    upgradeScriptureBlocks(this.el.editor);
    this.hist = [this.el.editor.innerHTML];
    this.hIdx = 0;
    this.ink.setStrokes(note ? unpackStrokes(note) : []);
    this.renderMeta();
    this.hideHandle();
    this.el.scroll.scrollTop = 0;
    this.el.saveState.textContent = '';
  }

  /** Bibelstellen aus den Blöcken der Notiz lesen */
  extractRefs() {
    return $$('.scripture', this.el.editor)
      .map((b) => {
        try {
          const added = +b.dataset.added || this.note?.created || Date.now();
          return { ...JSON.parse(b.dataset.ref), color: b.dataset.color || 'yellow', added };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /**
   * Speichern. Während mit dem Stift geschrieben wird, wird nicht gespeichert (das würde
   * kurz ruckeln) – erst wenn der Stift ruht. `flushed` = sofort speichern (Notizwechsel, App schließen).
   */
  commit(flushed = false) {
    if (!this.note || !this.dirty) return; // nur speichern, wenn sich wirklich etwas geändert hat
    if (!flushed && (this.ink.current || this.ink.penActive())) {
      this.save(); // später nochmal versuchen
      return;
    }
    this.dirty = false;
    const n = this.note;
    if (this.dirtyText || n.html == null) {
      const oldRefs = n.refs || [];
      n.title = this.el.title.value.trim();
      n.html = this.el.editor.innerHTML;
      const clone = this.el.editor.cloneNode(true);
      clone.querySelectorAll('.scripture').forEach((b) => b.replaceWith(' '));
      clone.querySelectorAll('p, div, li, h1, h2, h3, blockquote').forEach((b) => b.append(' '));
      n.text = clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 400);
      n.refs = this.extractRefs();
      // Automatische Überschrift (aus den Bibelstellen) folgt den Blöcken – eine selbst geschriebene bleibt
      const auto = n.autoTitle !== undefined ? n.title === n.autoTitle : !!n.title && n.title === titleFromRefs(oldRefs);
      if (auto) {
        const t = titleFromRefs(n.refs);
        n.title = t;
        n.autoTitle = t;
        if (this.el.title.value.trim() !== t) this.el.title.value = t;
      }
    }
    if (this.dirtyInk || !n.ink) {
      // Zeichnung als ein Datenblock statt hunderttausender Einzelzahlen (viel schneller zu speichern)
      n.ink = packStrokes(this.ink.strokes);
      delete n.strokes;
    }
    this.dirtyText = false;
    this.dirtyInk = false;
    n.updated = Date.now();
    // Tage, an denen an dieser Notiz gearbeitet wurde (für „Nach Tag filtern“)
    n.days = [...new Set([...(n.days || [dayKey(n.created)]), dayKey(n.updated)])];
    this.onSave(n);
    this.renderMeta();
    if (this.mode === 'text') {
      this.el.saveState.textContent = 'Gespeichert';
      clearTimeout(this._st);
      this._st = setTimeout(() => (this.el.saveState.textContent = ''), 1500);
    }
  }

  /** @param {'text'|'ink'} kind was sich geändert hat */
  changed(kind = 'text') {
    this.dirty = true;
    if (kind === 'ink') {
      this.dirtyInk = true;
      this.saveInk(); // länger warten – beim Schreiben gibt es ständig kurze Pausen
      return;
    }
    this.dirtyText = true;
    if (this.el.saveState.textContent !== '…') this.el.saveState.textContent = '…';
    this.save();
  }

  // ------------------------------------------------------------------ Rückgängig / Wiederholen
  /** Aktuellen Textstand als Schritt im Verlauf merken */
  record() {
    this.recordSoon.cancel?.();
    const html = this.el.editor.innerHTML;
    if (html === this.hist[this.hIdx]) return;
    this.hist = this.hist.slice(0, this.hIdx + 1);
    this.hist.push(html);
    if (this.hist.length > 200) this.hist.shift();
    this.hIdx = this.hist.length - 1;
  }

  undo() {
    if (this.mode === 'draw') return this.ink.undo();
    this.record();
    if (this.hIdx <= 0) return toast('Nichts mehr rückgängig zu machen');
    this.restoreHist(--this.hIdx);
  }

  redo() {
    if (this.mode === 'draw') return this.ink.redo();
    this.record();
    if (this.hIdx >= this.hist.length - 1) return;
    this.restoreHist(++this.hIdx);
  }

  restoreHist(i) {
    const ed = this.el.editor;
    ed.innerHTML = this.hist[i];
    this.hideHandle();
    const last = ed.lastElementChild;
    if (last && this.mode === 'text' && document.activeElement === ed) this.placeCaret(last, false);
    this.changed();
  }

  /** Strukturelle Änderung (Block einfügen, verschieben …) als eigenen Schritt speichern */
  structural(fn) {
    this.record();
    const res = fn();
    this.record();
    return res;
  }

  renderMeta() {
    const refs = this.note?.refs || [];
    this.el.meta.innerHTML = refs
      .map(
        (r, i) =>
          `<button class="chip" data-meta-ref="${i}"><i style="background:var(--c-${r.color || 'yellow'})"></i>${esc(formatRef(r, true))}</button>`
      )
      .join('');
  }

  // ------------------------------------------------------------------ Bibelstellen einfügen
  /**
   * Fügt einen Bibelstellen-Block ein.
   * @param {object} payload Auswahl aus der Bibel
   * @param {{x?:number, y?:number, color?:string}} opts Ablageposition (Bildschirm) oder ans Ende
   */
  insertScripture(payload, opts = {}) {
    return this.structural(() => this._insertScripture(payload, opts));
  }

  _insertScripture(payload, { x, y, color = 'yellow' } = {}) {
    const ed = this.el.editor;
    const tpl = document.createElement('template');
    tpl.innerHTML = scriptureHTML(payload, color);
    const block = tpl.content.firstChild;
    const after = document.createElement('p');
    after.innerHTML = '<br>';

    let anchor = null;
    let before = false;
    if (x != null && y != null) {
      ({ anchor, before } = this.blockAtPoint(x, y));
    } else if (this.lastRange && ed.contains(this.lastRange.startContainer)) {
      anchor = this.topBlock(this.lastRange.startContainer);
    }
    if (anchor && anchor.parentNode === ed) {
      if (before) ed.insertBefore(block, anchor);
      else anchor.after(block);
      // nur einen leeren Absatz anhängen, wenn danach keiner ist
      if (!block.nextElementSibling || block.nextElementSibling.classList.contains('scripture')) block.after(after);
    } else {
      // leere Absätze am Ende wiederverwenden
      const last = ed.lastElementChild;
      if (last && last.tagName === 'P' && !last.textContent.trim() && !last.querySelector('img')) last.before(block);
      else {
        ed.append(block);
        ed.append(after);
      }
      if (!block.nextElementSibling) ed.append(after);
    }
    // Cursor hinter den Block setzen
    const next = block.nextElementSibling;
    if (next) this.placeCaret(next);
    this.changed();
    this.save.flush();
    block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return block;
  }

  /** Was liegt unter einem Punkt im Notizfeld? (für Stift-Tipps durch die Zeichenfläche hindurch) */
  hitScripture(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (!this.el.editor.contains(el)) continue;
      const block = el.closest('.scripture');
      if (!block) continue;
      if (el.closest('.scripture-grip')) return { kind: 'grip', block };
      if (el.closest('.scripture-remove')) return { kind: 'remove', block };
      if (el.closest('.scripture-toggle')) return { kind: 'toggle', block };
      if (el.closest('.scripture-ref')) return { kind: 'ref', block };
      if (!block.hasAttribute('data-open')) return { kind: 'collapsed', block };
      if (el.closest('.scripture-text')) return { kind: 'text', block };
      return { kind: 'block', block };
    }
    return null;
  }

  /** Tipp auf einen Block ausführen: auf-/zuklappen oder zur Stelle springen */
  tapScripture(hit) {
    if (!hit) return false;
    if (hit.kind === 'ref') {
      this.onJump(JSON.parse(hit.block.dataset.ref));
      return true;
    }
    if (hit.kind === 'remove') {
      this.removeScripture(hit.block);
      return true;
    }
    if (hit.kind === 'toggle' || hit.kind === 'collapsed') {
      this.toggleScripture(hit.block);
      return true;
    }
    return false;
  }

  /** Wortgenauen Bereich zwischen zwei Bildschirmpunkten im Bibeltext eines Blocks bestimmen */
  wordRange(text, x0, y0, x1, y1) {
    const a = caretRangeAt(x0, y0);
    const b = caretRangeAt(x1, y1);
    const pick = (r, atEnd) => {
      if (r && text.contains(r.startContainer)) return [r.startContainer, r.startOffset];
      // außerhalb: an den Anfang bzw. das Ende des Textes
      const w = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let n, last = null, first = null;
      while ((n = w.nextNode())) { if (!first) first = n; last = n; }
      return atEnd ? [last, last?.data.length || 0] : [first, 0];
    };
    let [sn, so] = pick(a, false);
    let [en, eo] = pick(b, true);
    if (!sn || !en) return null;
    const range = document.createRange();
    range.setStart(sn, so);
    range.setEnd(sn, so);
    const cmp = range.comparePoint(en, eo);
    if (cmp < 0) [sn, so, en, eo] = [en, eo, sn, so];
    // auf ganze Wörter erweitern
    if (sn.nodeType === 3) while (so > 0 && /[\p{L}\p{N}'’-]/u.test(sn.data[so - 1])) so--;
    if (en.nodeType === 3) while (eo < en.data.length && /[\p{L}\p{N}'’-]/u.test(en.data[eo])) eo++;
    range.setStart(sn, so);
    range.setEnd(en, eo);
    return range.collapsed ? null : range;
  }

  /** Wörter im Bibeltext markieren (Farbe) bzw. Markierung entfernen (null) */
  markWords(text, range, color) {
    this.structural(() => {
      const nodes = [];
      const w = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = w.nextNode())) {
        if (range.intersectsNode(n) && n.data.length && !n.parentElement.closest('sup')) nodes.push(n);
      }
      const sc = range.startContainer, so = range.startOffset, ec = range.endContainer, eo = range.endOffset;
      for (let node of nodes) {
        let start = node === sc ? so : 0;
        let end = node === ec ? eo : node.data.length;
        if (start >= end) continue;
        if (end < node.data.length) node.splitText(end);
        if (start > 0) node = node.splitText(start);
        const wrap = node.parentElement.closest('span[style*="background"]');
        if (wrap && text.contains(wrap)) {
          // bestehende Markierung um dieses Stück auftrennen
          const before = wrap.cloneNode(false);
          const after = wrap.cloneNode(false);
          let cur = wrap.firstChild;
          while (cur && cur !== node && !cur.contains(node)) { const nx = cur.nextSibling; before.append(cur); cur = nx; }
          cur = node.nextSibling;
          while (cur) { const nx = cur.nextSibling; after.append(cur); cur = nx; }
          if (before.childNodes.length) wrap.before(before);
          if (after.childNodes.length) wrap.after(after);
          wrap.replaceWith(node);
        }
        if (color) {
          const s = document.createElement('span');
          s.style.backgroundColor = color;
          node.replaceWith(s);
          s.append(node);
        }
      }
      text.normalize();
    });
    this.changed();
  }

  /**
   * Bibelstellen-Block am Griff nach oben/unten ziehen. Eine goldene Linie zeigt die Zielposition.
   * Ein kurzer Tipp ohne Ziehen zeigt die Knöpfe ↑ ↓ zum schrittweisen Verschieben.
   */
  startBlockDrag(block, e) {
    const ed = this.el.editor;
    const id = e.pointerId;
    const y0 = e.clientY;
    let moved = false;
    let target = null; // Element, vor das eingefügt wird (null = ans Ende)
    const hint = this.el.dropHint;
    const pageTop = () => this.el.page.getBoundingClientRect().top;
    const findTarget = (y) => {
      for (const c of ed.children) {
        if (c === block) continue;
        const r = c.getBoundingClientRect();
        if (y < r.top + r.height / 2) return c;
      }
      return null;
    };
    const move = (ev) => {
      if (ev.pointerId !== id) return;
      const dy = ev.clientY - y0;
      if (!moved && Math.abs(dy) < 6) return;
      if (!moved) {
        moved = true;
        block.classList.add('dragging-block');
        document.body.classList.add('dragging-ref');
        this.hideHandle();
      }
      ev.preventDefault();
      block.style.transform = `translateY(${dy}px)`;
      target = findTarget(ev.clientY);
      const ref = target || ed.lastElementChild;
      const r = ref.getBoundingClientRect();
      hint.style.top = `${((target ? r.top - 6 : r.bottom + 4) - pageTop()) / (this.scale || 1)}px`;
      hint.classList.add('show');
      // am Rand automatisch scrollen
      const sr = this.el.scroll.getBoundingClientRect();
      if (ev.clientY < sr.top + 40) this.el.scroll.scrollTop -= 12;
      else if (ev.clientY > sr.bottom - 40) this.el.scroll.scrollTop += 12;
    };
    const up = (ev) => {
      if (ev.pointerId !== id) return;
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      block.classList.remove('dragging-block');
      document.body.classList.remove('dragging-ref');
      block.style.transform = '';
      hint.classList.remove('show');
      if (!moved) {
        this.showHandle(block); // kurzer Tipp: ↑ ↓ anzeigen
        return;
      }
      if (ev.type !== 'pointerup' || target === block.nextElementSibling) return;
      this.structural(() => {
        if (target) target.before(block);
        else ed.append(block);
      });
      this.changed();
      this.save.flush();
    };
    window.addEventListener('pointermove', move, { capture: true, passive: false });
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  }

  /** Eine Markierung im Bibeltext komplett entfernen */
  unmarkSpan(text, span) {
    this.structural(() => {
      while (span.firstChild) span.before(span.firstChild);
      span.remove();
      text.normalize();
    });
    this.changed();
  }

  /**
   * Notizseite auf die verfügbare Breite skalieren. Text, Bibelstellen, Raster und Handschrift
   * werden gemeinsam größer/kleiner – beim Drehen des iPads oder Verschieben des Trenners bleibt
   * alles an seinem Platz zueinander und nichts verschwindet.
   */
  applyScale() {
    const avail = this.el.scroll.clientWidth;
    if (!avail) return this.scale || 1;
    const s = Math.max(MIN_SCALE, Math.min(MAX_SCALE, avail / PAGE_W));
    if (Math.abs(s - (this.scale || 0)) > 0.001) {
      this.scale = s;
      this.el.page.style.zoom = String(s);
    }
    return this.scale;
  }

  /** Bibelstellen-Block entfernen (Rückgängig holt ihn zurück) */
  removeScripture(block) {
    if (!block) return;
    this.structural(() => {
      const next = block.nextElementSibling;
      block.remove();
      // leeren Absatz, der nur für den Block da war, mit entfernen
      if (next && next.tagName === 'P' && !next.textContent.trim() && next.previousElementSibling?.tagName === 'P' && !next.previousElementSibling.textContent.trim()) next.remove();
    });
    if (this.handleBlock === block) this.hideHandle();
    this.changed();
    this.save.flush();
    toast('Bibelstelle entfernt · Rückgängig mit ← oder 2-Finger-Tipp');
  }

  /** Weiteren Bibelstellen-Block direkt nach einem vorhandenen einfügen */
  insertScriptureAfter(prev, payload, { color = 'yellow' } = {}) {
    return this.structural(() => {
      const tpl = document.createElement('template');
      tpl.innerHTML = scriptureHTML(payload, color);
      const block = tpl.content.firstChild;
      prev.after(block);
      this.changed();
      this.save.flush();
      return block;
    });
  }

  toggleScripture(block) {
    if (!block) return;
    if (block.hasAttribute('data-open')) block.removeAttribute('data-open');
    else block.setAttribute('data-open', '');
    this.changed();
    if (this.handleBlock === block) this.positionHandle();
  }

  topBlock(node) {
    const ed = this.el.editor;
    let n = node?.nodeType === 3 ? node.parentNode : node;
    while (n && n.parentNode !== ed) {
      if (n === ed || !n.parentNode) return null;
      n = n.parentNode;
    }
    return n;
  }

  blockAtPoint(x, y) {
    const ed = this.el.editor;
    const blocks = [...ed.children];
    for (const b of blocks) {
      const r = b.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return { anchor: b, before: y < r.top + r.height / 2 && b === blocks[0] };
    }
    // zwischen Blöcken: nächster Block darüber
    let anchor = null;
    for (const b of blocks) if (b.getBoundingClientRect().bottom < y) anchor = b;
    if (!anchor && blocks.length) return { anchor: blocks[0], before: true };
    return { anchor, before: false };
  }

  /**
   * Schreibposition setzen. Den Cursor sichtbar setzen nur, wenn im Notizfeld schon geschrieben wird –
   * sonst würde sich auf dem iPad ungefragt die Tastatur öffnen. Die Position wird trotzdem gemerkt.
   */
  placeCaret(el, atStart = true) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(atStart);
    this.lastRange = r.cloneRange();
    const ed = this.el.editor;
    if (document.activeElement !== ed && !ed.contains(document.activeElement)) return;
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  // ------------------------------------------------------------------ Editor-Ereignisse
  bindEditor() {
    const ed = this.el.editor;
    ed.addEventListener('input', () => {
      this.changed();
      this.recordSoon();
    });
    // System-Rückgängig (Cmd+Z, iPad-Tastatur, Wischgeste) auf unseren Verlauf umleiten
    ed.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        e.inputType === 'historyUndo' ? this.undo() : this.redo();
        return;
      }
      // Im Bibeltext eines Blocks: nur Markieren/Formatieren erlaubt, kein Tippen oder Löschen
      const t = e.target instanceof Element ? e.target : e.target?.parentElement;
      if (t?.closest?.('.scripture-text') && !e.inputType.startsWith('format')) e.preventDefault();
    });
    ed.addEventListener('drop', (e) => {
      if (e.target.closest?.('.scripture-text')) e.preventDefault();
    }, true);
    this.el.title.addEventListener('input', () => this.changed());
    this.el.title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        ed.focus();
        if (ed.firstElementChild) this.placeCaret(ed.firstElementChild);
      }
    });

    document.addEventListener('selectionchange', () => {
      const s = window.getSelection();
      if (s.rangeCount && ed.contains(s.anchorNode)) {
        this.lastRange = s.getRangeAt(0).cloneRange();
        this.syncToolbar();
      }
    });

    // Neue Absätze immer als <p>
    ed.addEventListener('focus', () => {
      try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch {}
      if (!ed.innerHTML.trim()) {
        ed.innerHTML = '<p><br></p>';
        this.placeCaret(ed.firstChild);
      }
    });

    // Tippen auf einen Bibelstellen-Block soll nie die Tastatur öffnen
    ed.addEventListener('pointerdown', (e) => {
      const block = e.target.closest?.('.scripture');
      if (!block || this.mode !== 'text') return;
      if (e.target.closest('.scripture-grip')) {
        e.preventDefault();
        this.startBlockDrag(block, e);
        return;
      }
      const onText = e.target.closest('.scripture-text') && block.hasAttribute('data-open');
      if (!onText) {
        e.preventDefault(); // Pfeil, Kopfzeile, eingeklappte Vorschau: kein Cursor, keine Tastatur
        return;
      }
      // Im aufgeklappten Bibeltext Wörter auswählen, ohne dass das Notizfeld den Fokus bekommt
      if (document.activeElement !== ed) {
        ed.contentEditable = 'false';
        const restore = () => {
          setTimeout(() => {
            if (this.mode === 'text') ed.contentEditable = 'true';
          }, 60);
          window.removeEventListener('pointerup', restore, true);
          window.removeEventListener('pointercancel', restore, true);
        };
        window.addEventListener('pointerup', restore, true);
        window.addEventListener('pointercancel', restore, true);
      }
    });
    ed.addEventListener('mousedown', (e) => {
      const block = e.target.closest?.('.scripture');
      if (block && this.mode === 'text' && !(e.target.closest('.scripture-text') && block.hasAttribute('data-open'))) e.preventDefault();
    });

    ed.addEventListener('click', (e) => {
      const block = e.target.closest('.scripture');
      if (e.target.closest('.scripture-remove')) {
        e.preventDefault();
        this.removeScripture(block);
        return;
      }
      const hlSpan = e.target.closest('.scripture-text span[style*="background"]');
      if (hlSpan && block?.hasAttribute('data-open') && window.getSelection().isCollapsed) {
        this.unmarkSpan(block.querySelector('.scripture-text'), hlSpan);
        return;
      }
      const toggle = e.target.closest('.scripture-toggle');
      if (toggle || (block && !block.hasAttribute('data-open') && !e.target.closest('.scripture-ref'))) {
        e.preventDefault();
        this.toggleScripture(block);
        return;
      }
      const refBtn = e.target.closest('.scripture-ref');
      if (refBtn) {
        e.preventDefault();
        const ref = JSON.parse(refBtn.closest('.scripture').dataset.ref);
        this.onJump(ref);
        return;
      }
      // Checkliste abhaken
      const li = e.target.closest('ul.checklist > li');
      if (li) {
        const r = li.getBoundingClientRect();
        if (e.clientX - r.left < 26) {
          li.classList.toggle('done');
          this.changed();
          this.record();
        }
      }
    });

    // Enter in leerer Checkliste/Callout verlassen; Backspace vor Block löscht Block nicht versehentlich
    ed.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        document.execCommand(e.shiftKey ? 'outdent' : 'indent');
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? this.redo() : this.undo();
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        this.redo();
      }
    });

    // Einfügen: nur reiner Text (verhindert fremde Formatierungen)
    ed.addEventListener('paste', (e) => {
      const html = e.clipboardData.getData('text/html');
      if (html && html.includes('class="scripture"')) return; // eigene Blöcke erlauben
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, text);
    });

    this.el.meta.addEventListener('click', (e) => {
      const c = e.target.closest('[data-meta-ref]');
      if (c) this.onJump(this.note.refs[+c.dataset.metaRef]);
    });
  }

  restoreRange() {
    const ed = this.el.editor;
    if (document.activeElement !== ed) ed.focus({ preventScroll: true });
    if (this.lastRange && ed.contains(this.lastRange.startContainer)) {
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(this.lastRange);
    }
  }

  // ------------------------------------------------------------------ Werkzeugleiste
  bindToolbar() {
    const tools = $('#text-tools');
    // Buttons sollen den Fokus nicht aus dem Editor nehmen
    tools.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });
    tools.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });

    tools.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cmd]');
      if (b) {
        this.restoreRange();
        this.exec(b.dataset.cmd);
        return;
      }
      const p = e.target.closest('[data-pop]');
      if (p) this.togglePop(p);
    });

    const sel = $('#fmt-block');
    sel.addEventListener('change', () => {
      this.restoreRange();
      const v = sel.value;
      if (v === 'small') {
        document.execCommand('formatBlock', false, 'p');
        const blk = this.currentBlock();
        blk?.classList.add('small');
      } else {
        document.execCommand('formatBlock', false, v);
        this.currentBlock()?.classList.remove('small');
      }
      this.changed();
      this.el.editor.focus();
    });

    // Farbfelder
    $('.popover[data-for="hilite"]').innerHTML =
      COLORS.map((c) => `<button class="swatch" data-hilite="${c.id}" title="${c.name}" style="background:${HILITE[c.id]}"></button>`).join('') +
      `<button class="swatch none" data-hilite="none" title="Markierung entfernen"></button>`;
    $('.popover[data-for="color"]').innerHTML = TEXT_COLORS.map(
      (c) => `<button class="swatch" data-color="${c}" style="background:${c}"></button>`
    ).join('');
    $('.popover[data-for="block"]').innerHTML = BLOCK_COLORS.map(
      (c) => `<button data-block="${c.id}"><i style="background:${c.hex}"></i>Block ${c.name}</button>`
    ).join('');

    for (const pop of $$('.popover')) {
      pop.addEventListener('pointerdown', (e) => e.preventDefault());
      pop.addEventListener('mousedown', (e) => e.preventDefault());
      pop.addEventListener('click', (e) => {
        const t = e.target.closest('button');
        if (!t) return;
        const r = this.lastRange;
        const inScripture = r && !r.collapsed && r.commonAncestorContainer.parentElement?.closest?.('.scripture-text, .scripture');
        if (t.dataset.hilite && inScripture) {
          const text = (r.startContainer.parentElement || r.startContainer).closest('.scripture')?.querySelector('.scripture-text');
          if (text) {
            this.markWords(text, r, t.dataset.hilite === 'none' ? null : HILITE[t.dataset.hilite]);
            window.getSelection().removeAllRanges();
            this.closePops();
            return;
          }
        }
        this.restoreRange();
        document.execCommand('styleWithCSS', false, true);
        if (t.dataset.hilite) {
          document.execCommand('hiliteColor', false, t.dataset.hilite === 'none' ? 'transparent' : HILITE[t.dataset.hilite]);
        } else if (t.dataset.color) {
          document.execCommand('foreColor', false, t.dataset.color);
          $('.a-color').style.borderBottomColor = t.dataset.color;
        } else if (t.dataset.block) {
          this.structural(() => this.insertCallout(t.dataset.block));
        }
        this.closePops();
        this.changed();
      });
    }
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.popover') && !e.target.closest('[data-pop]')) this.closePops();
    });
  }

  togglePop(btn) {
    const pop = $(`.popover[data-for="${btn.dataset.pop}"]`);
    const open = pop.classList.contains('open');
    this.closePops();
    if (open) return;
    pop.classList.add('open');
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    pop.style.top = `${r.bottom + 6}px`;
  }
  closePops() {
    $$('.popover.open').forEach((p) => p.classList.remove('open'));
  }

  currentBlock() {
    const s = window.getSelection();
    return s.rangeCount ? this.topBlock(s.anchorNode) : null;
  }

  exec(cmd) {
    const ed = this.el.editor;
    this.record();
    switch (cmd) {
      case 'bigger':
      case 'smaller': {
        const cur = parseInt(document.queryCommandValue('fontSize'), 10) || 3;
        const next = Math.max(1, Math.min(7, cur + (cmd === 'bigger' ? 1 : -1)));
        document.execCommand('styleWithCSS', false, false);
        document.execCommand('fontSize', false, String(next));
        break;
      }
      case 'checklist': {
        let li = window.getSelection().anchorNode;
        li = li?.nodeType === 3 ? li.parentElement : li;
        let ul = li?.closest?.('ul');
        if (!ul || !ed.contains(ul)) {
          document.execCommand('insertUnorderedList');
          li = window.getSelection().anchorNode;
          li = li?.nodeType === 3 ? li.parentElement : li;
          ul = li?.closest?.('ul');
        }
        ul?.classList.toggle('checklist');
        break;
      }
      case 'quote': {
        const blk = this.currentBlock();
        document.execCommand('formatBlock', false, blk?.tagName === 'BLOCKQUOTE' ? 'p' : 'blockquote');
        break;
      }
      case 'hr': {
        const blk = this.currentBlock();
        const hr = document.createElement('hr');
        const p = document.createElement('p');
        p.innerHTML = '<br>';
        if (blk) blk.after(hr);
        else ed.append(hr);
        hr.after(p);
        this.placeCaret(p);
        break;
      }
      default:
        document.execCommand(cmd);
    }
    this.changed();
    this.record();
    this.syncToolbar();
  }

  insertCallout(color) {
    const ed = this.el.editor;
    const blk = this.currentBlock();
    const div = document.createElement('div');
    div.className = 'callout';
    div.dataset.color = color;
    const s = window.getSelection();
    const selected = s.rangeCount && !s.isCollapsed && ed.contains(s.anchorNode) ? s.toString() : '';
    const p = document.createElement('p');
    if (selected) p.textContent = selected;
    else p.innerHTML = '<br>';
    div.append(p);
    if (selected) s.deleteFromDocument();
    if (blk && blk.parentNode === ed) {
      if (!blk.textContent.trim() && blk.tagName === 'P') blk.replaceWith(div);
      else blk.after(div);
    } else ed.append(div);
    if (!div.nextElementSibling) {
      const after = document.createElement('p');
      after.innerHTML = '<br>';
      div.after(after);
    }
    this.placeCaret(p, false);
  }

  syncToolbar() {
    const blk = this.currentBlock();
    if (!blk) return;
    const tag = blk.tagName.toLowerCase();
    const v = blk.classList.contains('small') ? 'small' : ['h1', 'h2', 'h3'].includes(tag) ? tag : 'p';
    $('#fmt-block').value = v;
    for (const c of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']) {
      let on = false;
      try { on = document.queryCommandState(c); } catch {}
      $(`#text-tools [data-cmd="${c}"]`)?.classList.toggle('active', on);
    }
  }

  // ------------------------------------------------------------------ Blöcke verschieben
  bindBlocks() {
    const ed = this.el.editor;
    const h = this.el.handle;
    const show = (target) => {
      if (document.body.classList.contains('dragging-ref')) return; // nicht während ein Block gezogen wird
      const blk = target?.closest?.('.scripture, .callout, blockquote, hr');
      if (!blk || !ed.contains(blk)) return;
      const top = this.topBlock(blk);
      if (top) this.showHandle(top);
    };
    ed.addEventListener('pointerover', (e) => { if (e.pointerType === 'mouse') show(e.target); });
    ed.addEventListener('click', (e) => show(e.target));
    document.addEventListener('selectionchange', () => {
      const s = window.getSelection();
      if (s.rangeCount && ed.contains(s.anchorNode)) {
        const n = s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode;
        if (n.closest('.callout, blockquote')) show(n);
      }
    });
    this.el.scroll.addEventListener('scroll', () => this.positionHandle(), { passive: true });
    h.addEventListener('pointerdown', (e) => e.preventDefault());
    h.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const blk = this.handleBlock;
      if (!act || !blk) return;
      this.record();
      if (act === 'up' && blk.previousElementSibling) blk.previousElementSibling.before(blk);
      if (act === 'down' && blk.nextElementSibling) blk.nextElementSibling.after(blk);
      if (act === 'dup') blk.after(blk.cloneNode(true));
      if (act === 'color') {
        const list = blk.classList.contains('scripture') ? COLORS.map((c) => c.id) : BLOCK_COLORS.map((c) => c.id);
        const i = list.indexOf(blk.dataset.color);
        blk.dataset.color = list[(i + 1) % list.length];
      }
      if (act === 'del') {
        blk.remove();
        this.hideHandle();
      }
      this.record();
      this.changed();
      this.save.flush();
      if (act !== 'del') this.positionHandle();
    });
  }

  showHandle(blk) {
    this.handleBlock = blk;
    const h = this.el.handle;
    h.classList.remove('hidden');
    h.querySelector('[data-act="color"]').style.display = blk.matches('.scripture, .callout') ? '' : 'none';
    this.positionHandle();
  }
  positionHandle() {
    const blk = this.handleBlock;
    const h = this.el.handle;
    if (!blk || !blk.isConnected) return this.hideHandle();
    const br = this.el.body.getBoundingClientRect();
    const r = blk.getBoundingClientRect();
    const top = r.top - br.top - h.offsetHeight - 4;
    if (r.bottom < br.top || r.top > br.bottom) return h.classList.add('hidden');
    h.classList.remove('hidden');
    h.style.top = `${Math.max(4, top)}px`;
    h.style.left = `${Math.min(r.right - br.left - h.offsetWidth, br.width - h.offsetWidth - 6)}px`;
    const color = blk.dataset.color;
    h.querySelector('.bh-color').style.color = color ? `var(--c-${color}, #888)` : '';
  }
  hideHandle() {
    this.handleBlock = null;
    this.el.handle.classList.add('hidden');
  }

  // ------------------------------------------------------------------ Drag & Drop (Desktop, nativ)
  bindDrop() {
    const body = this.el.body;
    body.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('application/x-bibelstelle')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      this.showDropHint(e.clientX, e.clientY);
    });
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) this.hideDropHint();
    });
    body.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('application/x-bibelstelle');
      if (!raw) return;
      e.preventDefault();
      this.hideDropHint();
      this.onDropScripture(JSON.parse(raw), e.clientX, e.clientY);
    });
  }

  showDropHint(x, y) {
    const body = this.el.body;
    body.classList.add('drop-target');
    const hint = this.el.dropHint;
    const { anchor, before } = this.blockAtPoint(x, y);
    const pr = this.el.page.getBoundingClientRect();
    let top;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      top = (before ? r.top - 6 : r.bottom + 4) - pr.top;
    } else {
      top = this.el.editor.getBoundingClientRect().top - pr.top;
    }
    hint.style.top = `${top / (this.scale || 1)}px`;
    hint.classList.add('show');
  }
  hideDropHint() {
    this.el.body.classList.remove('drop-target');
    this.el.dropHint.classList.remove('show');
  }

  isOverEditor(x, y) {
    const r = this.el.body.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && getComputedStyle($('#notes-pane')).display !== 'none';
  }

  // ------------------------------------------------------------------ Modus
  setMode(mode) {
    if (this.mode === 'draw' && mode !== 'draw') this.save.flush(true);
    this.mode = mode;
    $$('.mode-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    $('#text-tools').classList.toggle('hidden', mode !== 'text');
    $('#draw-tools').classList.toggle('hidden', mode !== 'draw');
    this.el.body.classList.toggle('drawing', mode === 'draw');
    this.el.editor.contentEditable = mode === 'text' ? 'true' : 'false';
    this.el.title.readOnly = mode !== 'text';
    if (mode === 'draw') {
      this.hideHandle();
      document.activeElement?.blur?.();
    }
  }
}

// ============================================================================
// Zeichenebene (Apple Pencil / Maus / Finger)
// ============================================================================
class Ink {
  constructor(editor) {
    this.ed = editor;
    // Zwei Ebenen: „base“ = fertige Zeichnung, „live“ = der Strich, der gerade entsteht.
    // So wird beim Schreiben nur der neue Strich gemalt statt der ganzen Zeichnung.
    this.canvas = $('#ink');
    this.ctx = this.canvas.getContext('2d');
    this.live = $('#ink-live');
    this.lctx = this.live.getContext('2d');
    this.mcanvas = $('#ink-marker'); // Textmarker liegen unter der Stiftschrift
    this.mctx = this.mcanvas.getContext('2d');
    this.strokes = [];
    this.undoStack = [];
    this.tool = 'pen';
    this.color = PEN_COLORS[0];
    this.width = PEN_WIDTHS[1];
    this.pencilOnly = false;
    this.current = null;
    this.pan = null;
    this.raf = 0;
    this.liveRaf = 0;
    this.geo = null;
    this.bind();
    this.buildTools();
  }

  setStrokes(strokes) {
    this.strokes = strokes.map((s) => ({ ...s, p: [...s.p] }));
    this.undoStack = [];
    this.redoStack = [];
    this.schedule();
  }

  buildTools() {
    const colors = $('#pen-colors');
    colors.innerHTML = PEN_COLORS.map((c, i) => `<button class="pen-color${i === 0 ? ' active' : ''}" data-c="${c}" style="background:${c}"></button>`).join('');
    colors.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      this.color = b.dataset.c;
      $$('.pen-color', colors).forEach((x) => x.classList.toggle('active', x === b));
      if (this.tool === 'eraser') this.setTool('pen');
    });
    const widths = $('#pen-widths');
    widths.innerHTML = PEN_WIDTHS.map(
      (w, i) => `<button class="pen-width${i === 1 ? ' active' : ''}" data-w="${w}"><i style="width:${w * 2 + 2}px;height:${w * 2 + 2}px"></i></button>`
    ).join('');
    widths.addEventListener('click', (e) => {
      const b = e.target.closest('[data-w]');
      if (!b) return;
      this.width = +b.dataset.w;
      $$('.pen-width', widths).forEach((x) => x.classList.toggle('active', x === b));
    });
    $$('[data-pen]').forEach((b) => (b.onclick = () => this.setTool(b.dataset.pen)));
    $('#pencil-only').onclick = () => this.setPencilOnly(!this.pencilOnly);
    try {
      if (localStorage.getItem('pencilOnly') === '1') this.setPencilOnly(true);
    } catch {}
    $('#draw-clear').onclick = () => {
      if (!this.strokes.length) return;
      if (!confirm('Alle Zeichnungen dieser Notiz löschen?')) return;
      this.pushUndo();
      this.strokes = [];
      this.changed();
    };
  }

  setTool(t) {
    this.tool = t;
    $$('[data-pen]').forEach((b) => b.classList.toggle('active', b.dataset.pen === t));
  }

  pushUndo() {
    this.undoStack.push(this.strokes.slice());
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    if (!this.undoStack.length) return toast('Nichts mehr rückgängig zu machen');
    this.redoStack.push(this.strokes);
    this.strokes = this.undoStack.pop();
    this.changed();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.strokes);
    this.strokes = this.redoStack.pop();
    this.changed();
  }
  changed() {
    this.schedule();
    this.ed.changed('ink');
  }

  /** Lage der Notizseite einmal messen (statt bei jedem Stiftpunkt) */
  measure() {
    const br = this.ed.el.body.getBoundingClientRect();
    const pr = this.ed.el.page.getBoundingClientRect();
    const scale = this.ed.scale || 1;
    this.geo = { pageLeft: pr.left, pageTop: pr.top, ox: pr.left - br.left, oy: pr.top - br.top, h: br.height, scale };
    return this.geo;
  }

  // Koordinaten relativ zur Notiz-Seite (scrollen + Breitenänderung bleiben stimmig)
  toPage(e) {
    const g = this.geo || this.measure();
    return [(e.clientX - g.pageLeft) / g.scale, (e.clientY - g.pageTop) / g.scale];
  }

  /** Stift ist gerade aktiv (oder war es eben noch) -> Handballen ignorieren */
  penActive() {
    return !!this.current?.pen || Date.now() - this.lastPen < PALM_GRACE_MS;
  }

  /** Während mit dem Pencil geschrieben wird: keine Textauswahl/Kopieren-Menü (einmal pro Strich setzen) */
  startInking() {
    clearTimeout(this.inkingTimer);
    if (!document.body.classList.contains('inking')) document.body.classList.add('inking');
  }
  stopInkingSoon() {
    clearTimeout(this.inkingTimer);
    this.inkingTimer = setTimeout(() => {
      if (!this.current?.pen) document.body.classList.remove('inking');
    }, PALM_GRACE_MS);
  }

  bind() {
    const c = this.canvas;
    this.redoStack = [];
    this.lastPen = 0;
    new ResizeObserver(() => this.resize()).observe(this.ed.el.body);
    this.ed.el.scroll.addEventListener('scroll', () => {
      this.geo = null; // Lage hat sich geändert
      this.schedule();
      if (this.current) this.scheduleLive(true);
    }, { passive: true });

    // Lange Berührungen (Handballen) dürfen weder Lupe noch Kopieren-Menü öffnen
    c.addEventListener('touchstart', (e) => {
      if (this.ed.mode !== 'draw') return;
      e.preventDefault();
      // „Nur Pencil“: ein Finger scrollt die Notiz (über Touch-Ereignisse – auf dem iPad am zuverlässigsten)
      cancelAnimationFrame(this.glide);
      const t = e.changedTouches[0];
      if (!this.pencilOnly || e.touches.length !== 1 || t.touchType === 'stylus' || this.penActive()) {
        this.tpan = null;
        return;
      }
      this.tpan = { id: t.identifier, y: t.clientY, top: this.ed.el.scroll.scrollTop, on: false, hist: [[performance.now(), t.clientY]] };
    }, { passive: false });
    c.addEventListener('touchmove', (e) => {
      const tp = this.tpan;
      if (!tp) return;
      e.preventDefault();
      if (e.touches.length !== 1 || this.penActive()) return (this.tpan = null);
      const t = [...e.touches].find((x) => x.identifier === tp.id);
      if (!t) return;
      if (this.current?.finger) return; // Finger markiert gerade Bibeltext
      const dy = t.clientY - tp.y;
      if (!tp.on && Math.abs(dy) < 6) return;
      if (!tp.on) {
        tp.on = true;
        tp.y = t.clientY; // ab hier ohne Sprung scrollen
        tp.top = this.ed.el.scroll.scrollTop;
      }
      this.ed.el.scroll.scrollTop = tp.top - (t.clientY - tp.y);
      const now = performance.now();
      tp.hist.push([now, t.clientY]);
      while (tp.hist.length > 2 && now - tp.hist[0][0] > 100) tp.hist.shift();
    }, { passive: false });
    const tend = () => {
      const tp = this.tpan;
      this.tpan = null;
      if (!tp?.on || tp.hist.length < 2) return;
      // Schwung: nach dem Loslassen weitergleiten und sanft abbremsen
      const [t0, y0] = tp.hist[0];
      const [t1, y1] = tp.hist[tp.hist.length - 1];
      let v = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0; // px pro ms
      if (Math.abs(v) < 0.3 || performance.now() - t1 > 80) return;
      let last = performance.now();
      const step = (now) => {
        const dt = now - last;
        last = now;
        this.ed.el.scroll.scrollTop -= v * dt;
        v *= Math.pow(0.995, dt);
        if (Math.abs(v) > 0.02) this.glide = requestAnimationFrame(step);
      };
      this.glide = requestAnimationFrame(step);
    };
    c.addEventListener('touchend', tend);
    c.addEventListener('touchcancel', () => (this.tpan = null));
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      if (this.ed.mode !== 'draw') return;
      e.preventDefault();
      const isPen = e.pointerType === 'pen';

      if (isPen) {
        this.lastPen = Date.now();
        this.pan = null; // Hand hat evtl. zuerst aufgesetzt -> Scrollen abbrechen
        this.startInking();
        if (!this.pencilOnly) {
          // Apple Pencil erkannt: ab jetzt zeichnet nur noch der Stift
          this.setPencilOnly(true);
          toast('Apple Pencil erkannt – ab jetzt zeichnet nur der Stift, der Finger scrollt.');
        }
      } else if (e.pointerType === 'touch') {
        const palm = !this.pencilOnly && ((e.width || 0) > PALM_SIZE || (e.height || 0) > PALM_SIZE);
        if (palm || this.penActive()) return; // Handballen ignorieren
        if (this.pencilOnly) {
          capture(c, e.pointerId);
          const fhit = this.ed.hitScripture(e.clientX, e.clientY);
          if (fhit?.kind === 'text' && !this.current) {
            // Finger auf Bibeltext: Richtung entscheidet – seitlich = markieren, senkrecht = scrollen
            this.current = {
              mark: true, pending: true, finger: true, id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: Date.now(),
              top: this.ed.el.scroll.scrollTop, text: fhit.block.querySelector('.scripture-text'), remove: false,
            };
            return;
          }
          // Finger scrollt (siehe touchmove), Pencil zeichnet – hier nur für das Antippen merken
          this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), top: this.ed.el.scroll.scrollTop };
          return;
        }
      }
      if (this.current) return;
      capture(c, e.pointerId);
      this.measure();
      // Bibelstellen-Block unter dem Stift? Pfeil/Kopfzeile = antippen, Bibeltext = Wörter markieren
      const hit = this.ed.hitScripture(e.clientX, e.clientY);
      if (hit && hit.kind === 'grip') {
        this.ed.startBlockDrag(hit.block, e);
        return;
      }
      if (hit && hit.kind !== 'text') {
        this.current = { tap: true, hit, id: e.pointerId, pen: isPen, x0: e.clientX, y0: e.clientY };
        return;
      }
      if (hit && hit.kind === 'text') {
        this.current = {
          mark: true, id: e.pointerId, pen: isPen, x0: e.clientX, y0: e.clientY,
          text: hit.block.querySelector('.scripture-text'), remove: this.tool === 'eraser',
        };
        return;
      }
      const [x, y] = this.toPage(e);
      if (this.tool === 'eraser') {
        this.pushUndo();
        this.current = { eraser: true, pen: isPen, id: e.pointerId };
        this.erase(x, y);
        return;
      }
      this.pushUndo();
      const pr = isPen ? e.pressure || 0.5 : 0.5;
      // Der neue Strich kommt erst beim Absetzen in die fertige Zeichnung
      this.current = {
        id: e.pointerId,
        pen: isPen,
        drawn: 0,
        s: { t: this.tool, c: this.color, w: this.width, p: [r1(x), r1(y), r2(pr)] },
      };
      this.scheduleLive();
      // Stift auf einer Form/einem Strich ruhig halten -> verschieben (samt umrahmtem Inhalt)
      const started = this.current;
      clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => {
        if (this.current === started && started.s.p.length <= 6) this.startMove(started, x, y);
      }, MOVE_HOLD_MS);
    });

    c.addEventListener('pointermove', (e) => {
      if (this.pan && e.pointerId === this.pan.id) {
        if (this.penActive()) return (this.pan = null);
        if (!('ontouchstart' in window)) this.ed.el.scroll.scrollTop = this.pan.top - (e.clientY - this.pan.y); // ohne Touch-Ereignisse
        return;
      }
      const cur = this.current;
      if (!cur || e.pointerId !== cur.id) return;
      if (cur.pen) this.lastPen = Date.now();
      if (cur.tap) return;
      if (cur.mark) {
        if (cur.pending) {
          const dx = Math.abs(e.clientX - cur.x0);
          const dy = Math.abs(e.clientY - cur.y0);
          if (dy > 10 && dy > dx) {
            // senkrecht -> doch scrollen
            this.current = null;
            this.pan = { id: cur.id, x: cur.x0, y: cur.y0, t: 0, top: cur.top };
            if (!('ontouchstart' in window)) this.ed.el.scroll.scrollTop = cur.top - (e.clientY - cur.y0);
            return;
          }
          if (dx <= 8) return;
          cur.pending = false;
        }
        if (Math.abs(e.clientX - cur.x0) + Math.abs(e.clientY - cur.y0) > 6) cur.moved = true;
        this.previewMark(e.clientX, e.clientY);
        return;
      }
      if (cur.move) {
        this.moveTo(cur, e);
        return;
      }
      if (cur.s && cur.s.p.length <= 6) {
        // erste Bewegung: wer zeichnet, will nicht verschieben
        const [mx, my] = this.toPage(e);
        if (Math.hypot(mx - cur.s.p[0], my - cur.s.p[1]) > 6) clearTimeout(this.moveTimer);
      }
      if (cur.snapped) return; // Form ist schon eingerastet
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const p = cur.s ? cur.s.p : null;
      for (const ev of events.length ? events : [e]) {
        const [x, y] = this.toPage(ev);
        if (cur.eraser) {
          this.erase(x, y);
          continue;
        }
        const lx = p[p.length - 3];
        const ly = p[p.length - 2];
        if ((x - lx) * (x - lx) + (y - ly) * (y - ly) < 0.64) continue;
        const pr = ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5;
        p.push(r1(x), r1(y), r2(pr));
      }
      if (!cur.eraser) {
        this.scheduleLive();
        // Stift kurz ruhig halten -> Form erkennen und einrasten
        clearTimeout(this.holdTimer);
        this.holdTimer = setTimeout(() => {
          if (this.current === cur && !cur.snapped) this.snapShape(cur, true);
        }, HOLD_MS);
      }
    });

    const end = (e) => {
      if (this.pan && e.pointerId === this.pan.id) {
        const p = this.pan;
        this.pan = null;
        // kurzer Finger-Tipp ohne Bewegung (Stift-Modus): Block auf-/zuklappen bzw. zur Stelle springen
        if (e.type === 'pointerup' && Math.abs(e.clientX - p.x) < 10 && Math.abs(e.clientY - p.y) < 10 && Date.now() - p.t < 400) {
          this.ed.tapScripture(this.ed.hitScripture(e.clientX, e.clientY));
        }
        return;
      }
      const cur = this.current;
      if (!cur || e.pointerId !== cur.id) return;
      this.current = null;
      if (cur.pen) {
        this.lastPen = Date.now();
        this.stopInkingSoon();
      }
      clearTimeout(this.moveTimer);
      if (cur.move) {
        this.endMove(cur);
        return;
      }
      if (cur.tap) {
        if (e.type === 'pointerup' && Math.abs(e.clientX - cur.x0) < 12 && Math.abs(e.clientY - cur.y0) < 12) this.ed.tapScripture(cur.hit);
        return;
      }
      if (cur.mark) {
        this.clearLive();
        if (e.type !== 'pointerup') return;
        const tapped = !cur.moved && Math.abs(e.clientX - cur.x0) < 8 && Math.abs(e.clientY - cur.y0) < 8;
        if (tapped) {
          // Tipp: markiertes Wort -> Markierung weg, unmarkiertes Wort -> markieren
          this.toggleWordAt(cur.text, e.clientX, e.clientY, cur.remove);
          return;
        }
        const r = this.markRange(cur, e.clientX, e.clientY);
        if (r) this.ed.markWords(cur.text, r, cur.remove ? null : markerColorFor(this.color));
        return;
      }
      if (cur.eraser) {
        if (this.undoStack.length && this.undoStack[this.undoStack.length - 1].length === this.strokes.length) this.undoStack.pop();
        else this.ed.changed('ink');
        return;
      }
      clearTimeout(this.holdTimer);
      if (!cur.snapped && e.type === 'pointerup') this.snapShape(cur, false);
      cancelAnimationFrame(this.liveRaf);
      this.liveRaf = 0;
      this.clearLive();
      if (cur.s.t === 'pen' && !cur.snapped && this.scratchOut(cur.s)) {
        toast('Durchgestrichenes gelöscht · Rückgängig mit 2-Finger-Tipp');
        this.changed(); // ganze Zeichnung neu (Teile wurden gelöscht)
        return;
      }
      // Linie verlängern: liegt sie auf derselben Spur wie eine vorhandene Linie und schließt an, verbinden
      if (cur.s.k === 'line' && this.mergeLine(cur.s)) {
        this.changed();
        return;
      }
      // Strich in die fertige Zeichnung übernehmen – ohne alles neu zu malen
      this.strokes.push(cur.s);
      this.fitPage();
      if (cur.s.t === 'marker') {
        // restliche Stücke des Markers fertig malen (die letzten Punkte kamen evtl. nach dem letzten Bild)
        if (!this.raf) {
          this.prepare(this.mctx);
          this.drawStroke(this.mctx, cur.s, cur.drawn);
        }
      } else if (this.raf) {
        // ein vollständiges Neuzeichnen steht ohnehin an
      } else {
        this.prepare(this.ctx);
        this.drawStroke(this.ctx, cur.s);
      }
      this.ed.changed('ink');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      this.ed.el.scroll.scrollTop += e.deltaY;
    }, { passive: true });
  }

  setPencilOnly(on) {
    this.pencilOnly = on;
    $('#pencil-only').classList.toggle('active', on);
    try { localStorage.setItem('pencilOnly', on ? '1' : '0'); } catch {}
  }

  /**
   * Zickzack-Kritzelei über Geschriebenem erkennen ("zack, zack, zack").
   * Erkannt wird ein Strich, der mehrfach die Richtung umkehrt und bereits
   * vorhandene Schrift überdeckt. Dann werden diese Schrift und die Kritzelei gelöscht.
   * @returns {boolean} true, wenn etwas gelöscht wurde
   */
  scratchOut(s) {
    const p = s.p;
    const n = p.length / 3;
    if (n < 8) return false;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, len = 0;
    for (let i = 0; i < p.length; i += 3) {
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
      minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
      if (i) len += Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]);
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (Math.max(w, h) < 12) return false;
    // Strichlänge im Verhältnis zur Größe: Zickzack ist viel länger als breit
    if (len / Math.max(w, h) < 2.2) return false;

    // Richtungsumkehrungen zählen (mit Toleranz, damit Zittern nicht zählt)
    const reversals = (axis, size) => {
      const thr = Math.max(6, size * 0.3);
      let count = 0, dir = 0, ext = p[axis];
      for (let i = axis + 3; i < p.length; i += 3) {
        const v = p[i];
        if (dir === 0) {
          if (v > ext + thr) { dir = 1; ext = v; }
          else if (v < ext - thr) { dir = -1; ext = v; }
        } else if (dir === 1) {
          if (v > ext) ext = v;
          else if (v < ext - thr) { count++; dir = -1; ext = v; }
        } else {
          if (v < ext) ext = v;
          else if (v > ext + thr) { count++; dir = 1; ext = v; }
        }
      }
      return count;
    };
    // Hoch-runter-Kritzelei braucht mindestens 3 Bögen nach dem ersten Abstrich
    // (ein handgeschriebenes „m“ hat nur 2 und bleibt deshalb stehen).
    // Seitliches Hin-und-her braucht mindestens 3 Richtungswechsel.
    const vertical = reversals(1, h) >= MIN_VERTICAL_REVERSALS;
    const horizontal = reversals(0, w) >= MIN_HORIZONTAL_REVERSALS;
    if (!vertical && !horizontal) return false;

    // Welche vorhandenen Striche liegen unter der Kritzelei?
    const pad = 6;
    const inBox = (x, y) => x >= minX - pad && x <= maxX + pad && y >= minY - pad && y <= maxY + pad;
    const targets = new Set();
    for (const o of this.strokes) {
      if (o === s) continue;
      let inside = 0;
      for (let i = 0; i < o.p.length; i += 3) if (inBox(o.p[i], o.p[i + 1])) inside++;
      if (inside / (o.p.length / 3) >= 0.5) targets.add(o);
    }
    if (!targets.size) return false; // nichts darunter -> normaler Strich
    this.strokes = this.strokes.filter((o) => o !== s && !targets.has(o));
    // kurze Lösch-Animation: Striche blenden aus
    this.fading = { strokes: [...targets, s], start: performance.now() };
    return true;
  }

  erase(x, y) {
    const R = 14;
    const before = this.strokes.length;
    this.strokes = this.strokes.filter((s) => {
      for (let i = 0; i < s.p.length; i += 3) if (Math.hypot(s.p[i] - x, s.p[i + 1] - y) < R + s.w) return false;
      return true;
    });
    if (this.strokes.length !== before) this.schedule();
  }

  resize() {
    this.ed.applyScale(); // Seite an die neue Breite anpassen (z. B. iPad gedreht)
    const r = this.ed.el.body.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const cv of [this.canvas, this.live, this.mcanvas]) {
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
    }
    this.dpr = dpr;
    this.geo = null;
    this.schedule();
    if (this.current) this.scheduleLive(true);
  }

  /**
   * Form erkennen und den Strich durch die saubere Form ersetzen.
   * @param {boolean} held true = Stift wurde am Ende ruhig gehalten (dann auch kleine Formen)
   */
  snapShape(cur, held) {
    if (!cur?.s || cur.s.p.length < 15) return false;
    const shape = recognizeShape(cur.s.p, held ? 0 : AUTO_SHAPE_SIZE);
    if (!shape) return false;
    // Linien und Vierecke auf das gewählte Papier-Raster legen
    const snapped = shape.poly && snapToPaper(shape.kind, shape.poly, this.ed.el.page.dataset.paper);
    if (snapped) shape.points = densify(snapped, shape.closed, shape.pr);
    cur.s.p = shape.points;
    cur.snapped = shape.kind;
    cur.s.k = shape.kind;
    if (cur.s.t === 'marker') this.schedule(); // Marker-Ebene komplett neu
    else this.scheduleLive(true);
    return true;
  }

  /**
   * Verschieben starten: Strich unter dem Stift (bzw. Form, in deren Innerem der Stift steht)
   * und – bei geschlossenen Formen – alles, was darin liegt.
   */
  startMove(cur, x, y) {
    const pick = findMoveTarget(this.strokes, x, y);
    if (!pick) return false;
    // Ausgewählte Striche durch Kopien ersetzen, damit Rückgängig die alte Lage wiederherstellt
    const sel = new Set(pick);
    const copies = new Map();
    this.strokes = this.strokes.map((s) => {
      if (!sel.has(s)) return s;
      const c = { ...s, p: s.p.slice() };
      copies.set(c, s.p.slice());
      return c;
    });
    cur.move = { items: [...copies.keys()], orig: copies, x0: x, y0: y, dx: 0, dy: 0 };
    cur.s = null;
    // ausgewählte Striche ausblenden und auf der Live-Ebene zeichnen
    this.moving = new Set(cur.move.items);
    this.clearLive();
    this.schedule();
    this.drawMoving(cur);
    toast(pick.length > 1 ? `${pick.length} Elemente verschieben` : 'Verschieben', 1200);
    return true;
  }

  moveTo(cur, e) {
    const [x, y] = this.toPage(e);
    cur.move.dx = x - cur.move.x0;
    cur.move.dy = y - cur.move.y0;
    if (this.liveRaf) return;
    this.liveRaf = requestAnimationFrame(() => {
      this.liveRaf = 0;
      this.drawMoving(cur);
    });
  }

  drawMoving(cur) {
    const { items, orig, dx, dy } = cur.move;
    for (const s of items) {
      const o = orig.get(s);
      for (let i = 0; i < o.length; i += 3) {
        s.p[i] = r1(o[i] + dx);
        s.p[i + 1] = r1(o[i + 1] + dy);
      }
      BOXES.delete(s);
    }
    this.clearLive();
    const ctx = this.lctx;
    this.prepare(ctx);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of items) {
      if (s.t === 'marker') ctx.globalAlpha = 0.38;
      this.drawStroke(ctx, s);
      ctx.globalAlpha = 1;
      for (let i = 0; i < s.p.length; i += 3) {
        minX = Math.min(minX, s.p[i]); maxX = Math.max(maxX, s.p[i]);
        minY = Math.min(minY, s.p[i + 1]); maxY = Math.max(maxY, s.p[i + 1]);
      }
    }
    // gestrichelter Rahmen um die Auswahl
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#e8c26e';
    ctx.strokeRect(minX - 8, minY - 8, maxX - minX + 16, maxY - minY + 16);
    ctx.restore();
  }

  endMove(cur) {
    cancelAnimationFrame(this.liveRaf);
    this.liveRaf = 0;
    this.drawMoving(cur);
    this.moving = null;
    this.clearLive();
    if (Math.abs(cur.move.dx) < 1 && Math.abs(cur.move.dy) < 1) {
      this.undoStack.pop(); // nichts bewegt
      this.schedule();
      return;
    }
    this.changed();
  }

  /**
   * Neue Linie mit einer vorhandenen Linie auf derselben Spur verbinden (Verlängern).
   * @returns {boolean} true, wenn verbunden wurde (die neue Linie ersetzt dann die alte)
   */
  mergeLine(s) {
    const a = [s.p[0], s.p[1]];
    const z = [s.p[s.p.length - 3], s.p[s.p.length - 2]];
    const len = Math.hypot(z[0] - a[0], z[1] - a[1]);
    if (len < 4) return false;
    const ux = (z[0] - a[0]) / len, uy = (z[1] - a[1]) / len;
    const step = gridStep(this.ed.el.page.dataset.paper);
    const gap = Math.max(16, step * 0.6); // Haken an den Enden werden abgeschnitten -> etwas Luft lassen
    const tol = step ? 3 : 6; // auf dem Raster liegen Linien exakt, ohne Raster etwas großzügiger
    for (const o of this.strokes) {
      if (o.k !== 'line' || o.t !== s.t || o.c !== s.c) continue;
      const b = [o.p[0], o.p[1]];
      const y = [o.p[o.p.length - 3], o.p[o.p.length - 2]];
      // beide Endpunkte der alten Linie liegen auf der Spur der neuen?
      const off = (q) => Math.abs(-(q[0] - a[0]) * uy + (q[1] - a[1]) * ux);
      if (off(b) > tol || off(y) > tol) continue;
      // Abschnitte auf der Spur: berühren oder überlappen sie sich?
      const t = (q) => (q[0] - a[0]) * ux + (q[1] - a[1]) * uy;
      const n0 = 0, n1 = len;
      const o0 = Math.min(t(b), t(y)), o1 = Math.max(t(b), t(y));
      if (o0 > n1 + gap || o1 < n0 - gap) continue;
      const t0 = Math.min(n0, o0), t1 = Math.max(n1, o1);
      const pr = s.p[2];
      const pts = densify([[a[0] + ux * t0, a[1] + uy * t0], [a[0] + ux * t1, a[1] + uy * t1]], false, pr);
      const merged = { ...o, p: pts, w: Math.max(o.w, s.w) };
      this.strokes = this.strokes.map((x) => (x === o ? merged : x));
      toast('Linie verlängert', 1000);
      return true;
    }
    return false;
  }

  /** Tipp auf ein Wort im Bibeltext: Markierung entfernen bzw. Wort markieren */
  toggleWordAt(text, x, y, removeOnly = false) {
    const c = this.canvas;
    const prev = c.style.pointerEvents;
    c.style.pointerEvents = 'none';
    try {
      const el = document.elementFromPoint(x, y);
      const span = el?.closest?.('span[style*="background"]');
      if (span && text.contains(span)) {
        this.ed.unmarkSpan(text, span);
        return;
      }
      if (removeOnly) return;
      const r = this.ed.wordRange(text, x, y, x, y);
      if (r) this.ed.markWords(text, r, markerColorFor(this.color));
    } finally {
      c.style.pointerEvents = prev;
    }
  }

  /** Wortbereich vom Start- bis zum aktuellen Punkt (Zeichenfläche dafür kurz durchlässig machen) */
  markRange(cur, x, y) {
    const c = this.canvas;
    const prev = c.style.pointerEvents;
    c.style.pointerEvents = 'none'; // damit die Textposition unter dem Stift gefunden wird
    try {
      return this.ed.wordRange(cur.text, cur.x0, cur.y0, x, y);
    } finally {
      c.style.pointerEvents = prev;
    }
  }

  /** Vorschau beim Markieren im Bibeltext: überstrichene Wörter hervorheben */
  previewMark(x, y) {
    const cur = this.current;
    if (!cur?.mark) return;
    const r = this.markRange(cur, x, y);
    this.clearLive();
    if (!r) return;
    const br = this.ed.el.body.getBoundingClientRect();
    const dpr = this.dpr || 1;
    const ctx = this.lctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = cur.remove ? 'rgba(255,107,107,.28)' : markerColorFor(this.color);
    for (const rect of r.getClientRects()) ctx.fillRect(rect.left - br.left, rect.top - br.top, rect.width, rect.height);
  }

  /** Zeichenfläche auf die Seitenkoordinaten einstellen */
  prepare(ctx) {
    const dpr = this.dpr || 1;
    const g = this.geo || this.measure();
    ctx.setTransform(dpr * g.scale, 0, 0, dpr * g.scale, g.ox * dpr, g.oy * dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    return g;
  }

  // ---------------------------------------------------------------- fertige Zeichnung
  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  /**
   * Seite wächst mit der Handschrift: unter dem untersten Strich bleibt immer gut eine halbe
   * Bildschirmhöhe frei, damit man mit dem Finger weiterscrollen und weiterschreiben kann.
   */
  fitPage(bottom) {
    if (bottom == null) {
      bottom = 0;
      for (const s of this.strokes) {
        let box = BOXES.get(s);
        if (!box) BOXES.set(s, (box = bbox(s.p)));
        if (box[3] > bottom) bottom = box[3];
      }
    }
    const vis = this.ed.el.scroll.clientHeight / (this.ed.scale || 1);
    if (!vis) return;
    const h = Math.round(Math.max(vis * 1.5, bottom + vis * 0.6) / 50) * 50; // in Stufen, damit nichts zappelt
    if (h !== this._pageH) {
      this._pageH = h;
      this.ed.el.page.style.minHeight = h + 'px';
    }
  }

  draw() {
    const ctx = this.ctx;
    const mctx = this.mctx;
    for (const [c, cv] of [[ctx, this.canvas], [mctx, this.mcanvas]]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
    }
    const g = this.prepare(ctx);
    this.prepare(mctx);
    const minY = (-g.oy - 50) / g.scale;
    const maxY = (-g.oy + g.h + 50) / g.scale;
    let bottom = 0;
    for (const s of this.strokes) {
      let box = BOXES.get(s);
      if (!box) BOXES.set(s, (box = bbox(s.p)));
      if (box[3] > bottom) bottom = box[3];
      if (box[3] < minY || box[1] > maxY) continue; // nur sichtbare Striche zeichnen
      if (this.moving?.has(s)) continue; // wird gerade verschoben (Live-Ebene)
      this.drawStroke(s.t === 'marker' ? mctx : ctx, s);
    }
    this.fitPage(bottom);
    // Marker, der gerade gemalt wird, gehört mit auf die Marker-Ebene
    const cur = this.current;
    if (cur?.s?.t === 'marker') {
      this.drawStroke(mctx, cur.s);
      cur.drawn = cur.s.p.length;
    }
    // Lösch-Animation (ausblenden + leicht schrumpfen)
    if (this.fading) {
      const t = (performance.now() - this.fading.start) / FADE_MS;
      if (t >= 1) {
        this.fading = null;
      } else {
        for (const s of this.fading.strokes) {
          const c = s.t === 'marker' ? mctx : ctx;
          c.globalAlpha = 1 - t;
          this.drawStroke(c, { ...s, c: t < 0.35 ? '#ff6b6b' : s.c, w: s.w * (1 - t * 0.6) });
          c.globalAlpha = 1;
        }
        this.schedule();
      }
    }
  }

  // ---------------------------------------------------------------- Strich, der gerade entsteht
  clearLive() {
    this.lctx.setTransform(1, 0, 0, 1, 0, 0);
    this.lctx.clearRect(0, 0, this.live.width, this.live.height);
  }

  scheduleLive(full = false) {
    if (full && this.current) this.current.drawn = 0;
    if (this.liveRaf) return;
    this.liveRaf = requestAnimationFrame(() => {
      this.liveRaf = 0;
      this.drawLive();
    });
  }

  drawLive() {
    const cur = this.current;
    if (!cur || !cur.s) return;
    const ctx = this.lctx;
    const s = cur.s;
    if (s.t === 'marker') {
      // Marker deckend auf seine eigene Ebene – die Ebene selbst ist durchsichtig
      this.prepare(this.mctx);
      this.drawStroke(this.mctx, s, cur.drawn);
    } else if (cur.drawn === 0) {
      this.clearLive();
      this.prepare(ctx);
      this.drawStroke(ctx, s);
    } else {
      this.prepare(ctx);
      this.drawStroke(ctx, s, cur.drawn); // nur die neuen Stücke
    }
    cur.drawn = s.p.length;
  }

  /**
   * Strich zeichnen. Abschnitte mit gleicher Breite werden zu einem Pfad zusammengefasst (schnell).
   * @param {number} from ab welchem Punkt-Index (für das schrittweise Zeichnen des aktuellen Strichs)
   */
  drawStroke(ctx, s, from = 0) {
    const p = s.p;
    if (s.t === 'marker') {
      ctx.strokeStyle = s.c;
      ctx.lineWidth = s.w * 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const start = Math.max(0, from - 3);
      ctx.beginPath();
      ctx.moveTo(p[start], p[start + 1]);
      for (let i = start + 3; i < p.length; i += 3) ctx.lineTo(p[i], p[i + 1]);
      if (p.length === 3) ctx.lineTo(p[0] + 0.1, p[1]);
      ctx.stroke();
      return;
    }
    ctx.strokeStyle = s.c;
    ctx.fillStyle = s.c;
    if (p.length === 3) {
      ctx.beginPath();
      ctx.arc(p[0], p[1], (s.w * (0.5 + p[2])) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    // geglättete Linie mit druckabhängiger Breite
    let width = -1;
    let open = false;
    const startAt = Math.max(3, from - 3);
    for (let i = startAt; i < p.length; i += 3) {
      const x0 = p[i - 3], y0 = p[i - 2];
      const x1 = p[i], y1 = p[i + 1];
      const w = Math.round(s.w * (0.45 + ((p[i - 1] + p[i + 2]) / 2) * 1.1) * 4) / 4;
      const sx = i >= 6 ? (p[i - 6] + x0) / 2 : x0;
      const sy = i >= 6 ? (p[i - 5] + y0) / 2 : y0;
      if (w !== width) {
        if (open) ctx.stroke();
        ctx.lineWidth = w;
        width = w;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        open = true;
      }
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      if (i >= 6) ctx.quadraticCurveTo(x0, y0, mx, my);
      else ctx.lineTo(mx, my);
      if (i === p.length - 3) ctx.lineTo(x1, y1);
    }
    if (open) ctx.stroke();
  }
}

const BOXES = new WeakMap(); // Strich -> Begrenzungsrahmen (zwischengespeichert)

/** Begrenzungsrahmen eines Strichs [minX, minY, maxX, maxY] */
function bbox(p) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < a) a = p[i];
    if (p[i] > c) c = p[i];
    if (p[i + 1] < b) b = p[i + 1];
    if (p[i + 1] > d) d = p[i + 1];
  }
  return [a, b, c, d];
}

/** Ältere Bibelstellen-Blöcke um Aufklapp-Pfeil und Markierbarkeit ergänzen */
function upgradeScriptureBlocks(root) {
  for (const b of root.querySelectorAll('.scripture')) {
    if (!b.querySelector('.scripture-grip')) b.insertAdjacentHTML('afterbegin', '<button class="scripture-grip" type="button" contenteditable="false" aria-label="Bibelstelle verschieben" title="Gedrückt halten und ziehen zum Verschieben"><svg viewBox="0 0 24 24"><g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></g></svg></button>');
    if (b.querySelector('.scripture-toggle') && !b.querySelector('.scripture-remove')) {
      b.querySelector('.scripture-toggle').insertAdjacentHTML('afterend', '<button class="scripture-remove" type="button" contenteditable="false" aria-label="Bibelstelle entfernen" title="Entfernen"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>');
    }
    if (!b.querySelector('.scripture-toggle')) {
      b.querySelector('.scripture-ref')?.insertAdjacentHTML('afterend', '<button class="scripture-toggle" type="button" contenteditable="false" aria-label="Text auf- oder zuklappen"><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button><button class="scripture-remove" type="button" contenteditable="false" aria-label="Bibelstelle entfernen" title="Entfernen"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>');
    }
    const t = b.querySelector('.scripture-text');
    if (t) {
      t.removeAttribute('contenteditable'); // nur markierbar, nicht bearbeitbar -> keine Tastatur
      t.removeAttribute('spellcheck');
    }
  }
}

// ---------------------------------------------------------------------------
// Formerkennung: Linie, Dreieck, Viereck, Kreis/Ellipse
// ---------------------------------------------------------------------------
/**
 * @param {number[]} p Punkte [x, y, Druck, …]
 * @param {number} minSize kleinste Diagonale, ab der erkannt wird (0 = jede Größe)
 * @returns {{kind: string, points: number[]} | null}
 */
export function recognizeShape(p, minSize = 0) {
  const pts = [];
  let pr = 0;
  const raw = [];
  for (let i = 0; i < p.length; i += 3) { raw.push([p[i], p[i + 1]]); pr += p[i + 2]; }
  pr = pr / raw.length;
  {
    let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
    for (const [x, y] of raw) { rx0 = Math.min(rx0, x); rx1 = Math.max(rx1, x); ry0 = Math.min(ry0, y); ry1 = Math.max(ry1, y); }
    pts.push(...resample(raw, Math.max(3, Math.hypot(rx1 - rx0, ry1 - ry0) / 40)));
  }
  pr *= pts.length; // (Durchschnitt wird unten berechnet)
  pr = Math.round((pr / pts.length) * 100) / 100;
  const n = pts.length;
  if (n < 5) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, len = 0;
  pts.forEach(([x, y], i) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (i) len += Math.hypot(x - pts[i - 1][0], y - pts[i - 1][1]);
  });
  const w = maxX - minX, h = maxY - minY, diag = Math.hypot(w, h);
  if (diag < 18) return null;
  const big = diag >= minSize; // Linien und Kreise nur groß automatisch (Handschrift: „l“, „o“ …)
  const A = pts[0], Z = pts[n - 1];
  const chord = Math.hypot(Z[0] - A[0], Z[1] - A[1]);
  const out = (kind, poly, closed) => ({ kind, poly, closed, pr, points: densify(poly, closed, pr) });

  // --- gerade Linie: beste Gerade durch die Punkte (ohne die Haken beim Aufsetzen/Abheben)
  if (chord > 0.75 * len) {
    const cut = Math.max(1, Math.round(n * 0.07));
    const core = n > 8 ? pts.slice(cut, n - cut) : pts;
    // Hauptrichtung (Hauptkomponente) der Punkte
    let mx = 0, my = 0;
    for (const [x, y] of core) { mx += x; my += y; }
    mx /= core.length; my /= core.length;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of core) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ux = Math.cos(th), uy = Math.sin(th);
    let maxDev = 0, sq = 0;
    for (const [x, y] of core) {
      const d = Math.abs(-(x - mx) * uy + (y - my) * ux);
      maxDev = Math.max(maxDev, d);
      sq += d * d;
    }
    const rms = Math.sqrt(sq / core.length);
    if (maxDev <= Math.max(4, chord * 0.07) && rms <= Math.max(1.8, chord * 0.03)) {
      if (diag < LINE_AUTO_SIZE && !(minSize === 0)) return null; // kurze Striche (Handschrift) nur nach Halten
      // Endpunkte: alle Punkte auf die Gerade projizieren (Haken zählen hier nicht)
      let t0 = Infinity, t1 = -Infinity;
      for (const [x, y] of core) { const t = (x - mx) * ux + (y - my) * uy; t0 = Math.min(t0, t); t1 = Math.max(t1, t); }
      let a = [mx + ux * t0, my + uy * t0], z = [mx + ux * t1, my + uy * t1];
      // Richtung wie gezeichnet beibehalten
      if ((Z[0] - A[0]) * ux + (Z[1] - A[1]) * uy < 0) [a, z] = [z, a];
      const ang = (Math.atan2(z[1] - a[1], z[0] - a[0]) * 180) / Math.PI;
      const near = (t) => Math.abs(((ang - t + 540) % 360) - 180) < 8;
      if (near(0) || near(180)) { const yy = (a[1] + z[1]) / 2; a = [a[0], yy]; z = [z[0], yy]; } // waagerecht
      else if (near(90) || near(-90)) { const xx = (a[0] + z[0]) / 2; a = [xx, a[1]]; z = [xx, z[1]]; } // senkrecht
      return out('line', [a, z], false);
    }
    return null;
  }

  // --- geschlossene Formen
  if (chord > Math.max(24, 0.3 * diag) || len < 2.2 * diag * 0.9) return null;
  const poly = cornersOf(pts, diag);
  // Vierecke/Dreiecke auch klein – aber nur, wenn die Seiten wirklich gerade sind (sonst z. B. „D“, „A“)
  const straight = (pg) => {
    let maxD = 0, sum = 0;
    for (const [x, y] of pts) {
      let d = Infinity;
      for (let i = 0; i < pg.length; i++) d = Math.min(d, distToSeg(x, y, pg[i], pg[(i + 1) % pg.length]));
      maxD = Math.max(maxD, d);
      sum += d;
    }
    return maxD <= Math.max(3, diag * 0.1) && sum / pts.length <= Math.max(1.6, diag * 0.04);
  };
  if (poly.length === 4 && straight(poly)) {
    const angles = poly.map((q, i) => angleAt(poly[(i + 3) % 4], q, poly[(i + 1) % 4]));
    if (angles.every((g) => Math.abs(g - 90) < 25)) {
      // fast achsenparallel -> sauberes Rechteck
      const tilt = (Math.atan2(poly[1][1] - poly[0][1], poly[1][0] - poly[0][0]) * 180) / Math.PI;
      const t = ((tilt % 90) + 90) % 90;
      if (t < 12 || t > 78) return out('rect', [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]], true);
      return out('rect', poly, true);
    }
  }
  // Kreis/Ellipse: Abstand der Punkte zur Ellipse durch den Rahmen
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, rx = w / 2, ry = h / 2;
  if (rx < 6 || ry < 6) return null;
  const err = pts.reduce((s, [x, y]) => s + Math.abs(Math.hypot((x - cx) / rx, (y - cy) / ry) - 1), 0) / n;
  if (err < 0.13 && big) {
    const round = Math.abs(rx - ry) / Math.max(rx, ry) < 0.18;
    const r = (rx + ry) / 2;
    const RX = round ? r : rx, RY = round ? r : ry;
    const steps = Math.max(32, Math.round((Math.PI * (RX + RY)) / 4));
    const ring = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      ring.push([cx + RX * Math.cos(a), cy + RY * Math.sin(a)]);
    }
    return { kind: round ? 'circle' : 'ellipse', points: ring.flatMap(([x, y]) => [r1(x), r1(y), pr]) };
  }
  return null;
}

/** Ist ein Strich geschlossen (Kreis, Viereck, Schleife um etwas herum)? */
function isClosedStroke(s) {
  const p = s.p;
  if (p.length < 24) return false;
  const box = BOXES.get(s) || bbox(p);
  const diag = Math.hypot(box[2] - box[0], box[3] - box[1]);
  if (diag < 30) return false;
  return Math.hypot(p[0] - p[p.length - 3], p[1] - p[p.length - 2]) <= Math.max(18, diag * 0.25);
}

function insidePolygon(x, y, p) {
  let inside = false;
  for (let i = 0, j = p.length - 3; i < p.length; j = i, i += 3) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Was soll verschoben werden? Ein Strich direkt unter dem Stift, sonst die kleinste geschlossene Form,
 * in der der Stift steht. Bei geschlossenen Formen kommt alles mit, was darin liegt.
 */
function findMoveTarget(strokes, x, y) {
  let hit = null;
  let best = Infinity;
  for (const s of strokes) {
    const p = s.p;
    const tol = Math.max(8, s.w * (s.t === 'marker' ? 3 : 1.5));
    for (let i = 0; i < p.length; i += 3) {
      const d = Math.hypot(p[i] - x, p[i + 1] - y);
      if (d < tol && d < best) { best = d; hit = s; }
    }
  }
  if (!hit) {
    let area = Infinity;
    for (const s of strokes) {
      if (!isClosedStroke(s) || !insidePolygon(x, y, s.p)) continue;
      const b = bbox(s.p);
      const a = (b[2] - b[0]) * (b[3] - b[1]);
      if (a < area) { area = a; hit = s; }
    }
  }
  if (!hit) return null;
  const items = [hit];
  if (isClosedStroke(hit)) {
    for (const s of strokes) {
      if (s === hit) continue;
      let inside = 0;
      for (let i = 0; i < s.p.length; i += 3) if (insidePolygon(s.p[i], s.p[i + 1], hit.p)) inside++;
      if (inside / (s.p.length / 3) >= 0.7) items.push(s);
    }
  }
  return items;
}

// Papier-Raster (muss zu den Hintergründen in app.css passen; Koordinaten = Seitenkoordinaten)
const PAPER_GRID = {
  dots: { step: 24, ox: 12, oy: 12 }, // Punkte in der Mitte jeder 24-px-Zelle
  grid: { step: 28, ox: 0.5, oy: 0.5 }, // Kästchenlinien am Anfang jeder 28-px-Zelle
  lines: { step: 34, ox: null, oy: 33.5 }, // Linien am unteren Rand jeder 34-px-Zeile (nur senkrecht einrasten)
};

function gridStep(paper) {
  return PAPER_GRID[paper]?.step || 0;
}

/** Eckpunkte einer Linie/eines Vierecks auf das Papier-Raster legen (oder null, wenn kein Raster) */
function snapToPaper(kind, poly, paper) {
  const g = PAPER_GRID[paper];
  if (!g || (kind !== 'line' && kind !== 'rect')) return null;
  const sx = (x) => (g.ox == null ? x : g.ox + Math.round((x - g.ox) / g.step) * g.step);
  const sy = (y) => g.oy + Math.round((y - g.oy) / g.step) * g.step;
  if (kind === 'line') {
    const [a, z] = poly;
    const horizontal = Math.abs(a[1] - z[1]) < 0.5;
    const vertical = Math.abs(a[0] - z[0]) < 0.5;
    if (g.ox == null) {
      // Linien-Papier: nur waagerechte Linien auf die Papierlinie legen
      if (!horizontal) return null;
      const yy = sy(a[1]);
      return [[a[0], yy], [z[0], yy]];
    }
    let A = [sx(a[0]), sy(a[1])], Z = [sx(z[0]), sy(z[1])];
    if (horizontal) Z = [Z[0], A[1]];
    if (vertical) Z = [A[0], Z[1]];
    if (A[0] === Z[0] && A[1] === Z[1]) return null; // zu kurz für das Raster
    return [A, Z];
  }
  // Viereck: achsenparallel -> Ecken aufs Raster, sonst unverändert
  const xs = poly.map((q) => q[0]), ys = poly.map((q) => q[1]);
  const axis = poly.every((q) => xs.some((x) => Math.abs(x - q[0]) < 0.5) && ys.some((y) => Math.abs(y - q[1]) < 0.5)) &&
    new Set(xs.map(Math.round)).size <= 2 && new Set(ys.map(Math.round)).size <= 2;
  if (!axis) return null;
  let x0 = sx(Math.min(...xs)), x1 = sx(Math.max(...xs)), y0 = sy(Math.min(...ys)), y1 = sy(Math.max(...ys));
  if (x0 === x1 || y0 === y1) return null;
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** Überschrift aus den Bibelstellen einer Notiz, z. B. „Johannes 3,16.18; Römer 8,28“ */
export function titleFromRefs(refs) {
  const out = [];
  let i = 0;
  while (i < refs.length) {
    const r = refs[i];
    const vs = [];
    while (i < refs.length && refs[i].book === r.book && refs[i].chapter === r.chapter) {
      const q = refs[i++];
      vs.push(q.vs === q.ve ? `${q.vs}` : `${q.vs}-${q.ve}`);
    }
    out.push([formatRef({ book: r.book, chapter: r.chapter, vs: r.vs, ve: r.ve }), ...vs.slice(1)].join('.'));
  }
  return out.join('; ');
}

/** Punkte in gleichmäßigem Abstand neu abtasten (glättet das Zittern vieler Stiftpunkte) */
function resample(pts, step) {
  if (pts.length < 3) return pts.slice();
  const out = [pts[0]];
  let [px, py] = pts[0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    let [x, y] = pts[i];
    let d = Math.hypot(x - px, y - py);
    while (acc + d >= step) {
      const t = (step - acc) / d;
      px = px + (x - px) * t;
      py = py + (y - py) * t;
      out.push([px, py]);
      d = Math.hypot(x - px, y - py);
      acc = 0;
    }
    acc += d;
    px = x;
    py = y;
  }
  const last = pts[pts.length - 1];
  if (Math.hypot(last[0] - out[out.length - 1][0], last[1] - out[out.length - 1][1]) > step * 0.3) out.push(last);
  return out;
}

function distToSeg(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

function angleAt(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const d = (v1[0] * v2[0] + v1[1] * v2[1]) / ((Math.hypot(...v1) * Math.hypot(...v2)) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

/** Ecken einer geschlossenen Form (Douglas-Peucker + fast gerade Ecken entfernen) */
function cornersOf(pts, diag) {
  const eps = diag * 0.07;
  const rdp = (arr) => {
    if (arr.length < 3) return arr;
    const a = arr[0], z = arr[arr.length - 1];
    let idx = 0, md = 0;
    for (let i = 1; i < arr.length - 1; i++) {
      const d = distToSeg(arr[i][0], arr[i][1], a, z);
      if (d > md) { md = d; idx = i; }
    }
    if (md <= eps) return [a, z];
    return [...rdp(arr.slice(0, idx + 1)).slice(0, -1), ...rdp(arr.slice(idx))];
  };
  // am weitesten vom Start entfernten Punkt teilen, damit die Form sauber in zwei Hälften zerfällt
  let far = 0, fd = 0;
  pts.forEach(([x, y], i) => { const d = Math.hypot(x - pts[0][0], y - pts[0][1]); if (d > fd) { fd = d; far = i; } });
  let poly = [...rdp(pts.slice(0, far + 1)).slice(0, -1), ...rdp([...pts.slice(far), pts[0]]).slice(0, -1)];
  // Ecken mit fast gestrecktem Winkel und zu nahe Punkte entfernen
  let changed = true;
  while (changed && poly.length > 2) {
    changed = false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i - 1 + poly.length) % poly.length], b = poly[i], c = poly[(i + 1) % poly.length];
      if (angleAt(a, b, c) > 150 || Math.hypot(b[0] - a[0], b[1] - a[1]) < diag * 0.12) {
        poly.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return poly;
}

/** Form in dichte Punkte umwandeln (für Radierer und gleichmäßiges Zeichnen) */
function densify(poly, closed, pr) {
  const out = [];
  const pts = closed ? [...poly, poly[0]] : poly;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    const steps = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / 4));
    for (let k = 0; k < steps; k++) out.push(r1(x0 + ((x1 - x0) * k) / steps), r1(y0 + ((y1 - y0) * k) / steps), pr);
  }
  const last = pts[pts.length - 1];
  out.push(r1(last[0]), r1(last[1]), pr);
  return out;
}

/** Stiftfarbe -> passende Textmarker-Farbe für Wörter im Bibeltext */
function markerColorFor(hex) {
  const map = {
    '#e8c26e': HILITE.yellow,
    '#6cd28c': HILITE.green,
    '#6eaaff': HILITE.blue,
    '#ff78b4': HILITE.pink,
    '#aa82ff': HILITE.purple,
    '#ff6b6b': HILITE.orange,
  };
  return map[hex] || HILITE.yellow; // Weiß/Grau -> Gelb
}

/** Zuletzt gewähltes Papier (für neue Notizen) */
function readPaper() {
  try {
    return localStorage.getItem('paper') || 'clean';
  } catch {
    return 'clean';
  }
}

/** Striche als ein Datenblock: {meta: [[Werkzeug, Farbe, Breite, Länge] …], data: Float32Array} */
export function packStrokes(strokes) {
  let total = 0;
  for (const s of strokes) total += s.p.length;
  const data = new Float32Array(total);
  const meta = [];
  let o = 0;
  for (const s of strokes) {
    data.set(s.p, o);
    meta.push(s.k ? [s.t, s.c, s.w, s.p.length, s.k] : [s.t, s.c, s.w, s.p.length]);
    o += s.p.length;
  }
  return { meta, data };
}

/** Striche einer Notiz lesen (kompaktes oder altes Format) */
export function unpackStrokes(note) {
  if (note.ink?.meta) {
    const { meta, data } = note.ink;
    const arr = data instanceof Float32Array ? data : Float32Array.from(data || []);
    let o = 0;
    return meta.map(([t, c, w, len, k]) => {
      const p = Array.from(arr.subarray(o, o + len), (v) => Math.round(v * 100) / 100);
      o += len;
      return k ? { t, c, w, p, k } : { t, c, w, p };
    });
  }
  return note.strokes || [];
}

const r1 = (n) => Math.round(n * 10) / 10;
const r2 = (n) => Math.round(n * 100) / 100;
function capture(el, id) {
  try {
    el.setPointerCapture(id);
  } catch {}
}
