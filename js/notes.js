// Linke Seite: Notiz-Editor (Text + Blöcke) und Zeichenebene für Apple Pencil
import { formatRef } from './books.js';
import { $, $$, esc, COLORS, debounce, toast, dayKey } from './util.js';

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
const PALM_SIZE = 40; // Kontaktfläche (px), ab der eine Berührung als Handballen gilt

/** HTML eines Bibelstellen-Blocks */
export function scriptureHTML(p, color = 'yellow') {
  const ref = { book: p.book, chapter: p.chapter, vs: p.vs, ve: p.ve };
  const verses = (p.verses || []).map((v) => `<sup>${v.n}</sup>${esc(v.t)}`).join(' ');
  return (
    `<div class="scripture" contenteditable="false" data-color="${color}" data-added="${Date.now()}" data-ref='${JSON.stringify(ref)}'>` +
    `<button class="scripture-ref" type="button">${esc(formatRef(ref))}<span class="scripture-trans">${esc(p.transShort || '')}</span></button>` +
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
      n.title = this.el.title.value.trim();
      n.html = this.el.editor.innerHTML;
      const clone = this.el.editor.cloneNode(true);
      clone.querySelectorAll('.scripture').forEach((b) => b.replaceWith(' '));
      clone.querySelectorAll('p, div, li, h1, h2, h3, blockquote').forEach((b) => b.append(' '));
      n.text = clone.textContent.replace(/\s+/g, ' ').trim().slice(0, 400);
      n.refs = this.extractRefs();
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

  placeCaret(el, atStart = true) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(atStart);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    this.lastRange = r.cloneRange();
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
      }
    });
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

    ed.addEventListener('click', (e) => {
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
    hint.style.top = `${top}px`;
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
    this.geo = { pageLeft: pr.left, pageTop: pr.top, ox: pr.left - br.left, oy: pr.top - br.top, h: br.height };
    return this.geo;
  }

  // Koordinaten relativ zur Notiz-Seite (scrollen + Breitenänderung bleiben stimmig)
  toPage(e) {
    const g = this.geo || this.measure();
    return [e.clientX - g.pageLeft, e.clientY - g.pageTop];
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
      if (this.ed.mode === 'draw') e.preventDefault();
    }, { passive: false });
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
        const palm = (e.width || 0) > PALM_SIZE || (e.height || 0) > PALM_SIZE;
        if (palm || this.penActive()) return; // Handballen ignorieren
        if (this.pencilOnly) {
          // Finger scrollt, Pencil zeichnet
          this.pan = { id: e.pointerId, y: e.clientY, top: this.ed.el.scroll.scrollTop };
          capture(c, e.pointerId);
          return;
        }
      }
      if (this.current) return;
      capture(c, e.pointerId);
      this.measure();
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
    });

    c.addEventListener('pointermove', (e) => {
      if (this.pan && e.pointerId === this.pan.id) {
        if (this.penActive()) return (this.pan = null);
        this.ed.el.scroll.scrollTop = this.pan.top - (e.clientY - this.pan.y);
        return;
      }
      const cur = this.current;
      if (!cur || e.pointerId !== cur.id) return;
      if (cur.pen) this.lastPen = Date.now();
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
      if (!cur.eraser) this.scheduleLive();
    });

    const end = (e) => {
      if (this.pan && e.pointerId === this.pan.id) {
        this.pan = null;
        return;
      }
      const cur = this.current;
      if (!cur || e.pointerId !== cur.id) return;
      this.current = null;
      if (cur.pen) {
        this.lastPen = Date.now();
        this.stopInkingSoon();
      }
      if (cur.eraser) {
        if (this.undoStack.length && this.undoStack[this.undoStack.length - 1].length === this.strokes.length) this.undoStack.pop();
        else this.ed.changed('ink');
        return;
      }
      cancelAnimationFrame(this.liveRaf);
      this.liveRaf = 0;
      this.clearLive();
      if (cur.s.t === 'pen' && this.scratchOut(cur.s)) {
        toast('Durchgestrichenes gelöscht · Rückgängig mit 2-Finger-Tipp');
        this.changed(); // ganze Zeichnung neu (Teile wurden gelöscht)
        return;
      }
      // Strich in die fertige Zeichnung übernehmen – ohne alles neu zu malen
      this.strokes.push(cur.s);
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

  /** Zeichenfläche auf die Seitenkoordinaten einstellen */
  prepare(ctx) {
    const dpr = this.dpr || 1;
    const g = this.geo || this.measure();
    ctx.setTransform(dpr, 0, 0, dpr, g.ox * dpr, g.oy * dpr);
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

  draw() {
    const ctx = this.ctx;
    const mctx = this.mctx;
    for (const [c, cv] of [[ctx, this.canvas], [mctx, this.mcanvas]]) {
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, cv.width, cv.height);
    }
    const g = this.prepare(ctx);
    this.prepare(mctx);
    const minY = -g.oy - 50;
    const maxY = -g.oy + g.h + 50;
    for (const s of this.strokes) {
      let box = BOXES.get(s);
      if (!box) BOXES.set(s, (box = bbox(s.p)));
      if (box[3] < minY || box[1] > maxY) continue; // nur sichtbare Striche zeichnen
      this.drawStroke(s.t === 'marker' ? mctx : ctx, s);
    }
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
    meta.push([s.t, s.c, s.w, s.p.length]);
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
    return meta.map(([t, c, w, len]) => {
      const p = Array.from(arr.subarray(o, o + len), (v) => Math.round(v * 100) / 100);
      o += len;
      return { t, c, w, p };
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
