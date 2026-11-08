// Rechte Seite: Bibeltext, Inhaltsverzeichnis, Navigation, Auswahl, Suche
import { BOOKS, getBook, parseRef, formatRef, parseCompact } from './books.js';
import { getChapter, getBookData, getTranslation, chapterCount, getXrefs, getHeadings } from './translations.js';
import { $, $$, esc, COLORS } from './util.js';

export class BibleView {
  /**
   * @param {object} o
   * @param {(book:number, chapter:number) => Array<{vs:number, ve:number, color:string, noteId?:string, noteTitle?:string}>} o.marksFor
   * @param {(book:number) => Set<number>} o.chaptersWithNotes
   * @param {(sel:object, action:string, extra?:any) => void} o.onAction
   * @param {(noteId:string) => void} o.onOpenNote
   * @param {(pos:object) => void} o.onNavigate
   */
  constructor(o) {
    this.o = o;
    this.trans = 'elb1905';
    this.pos = { book: 1, chapter: 1 };
    this.history = [];
    this.hIdx = -1;
    this.verses = [];
    this.sel = null; // {book, chapter, vs, ve}
    this.tapAnchor = null;
    this.layout = 'lines';
    this.searchScope = 'all';
    this.renderToken = 0;
    this.showXrefs = true;
    this.showHeadings = true;
    this.xrefMode = 'on'; // 'on' = wichtige markieren, 'all' = alle markieren
    this.xrefs = new Map();

    this.el = {
      scroll: $('#bible-scroll'),
      text: $('#bible-text'),
      refLabel: $('#ref-label'),
      back: $('#nav-back'),
      fwd: $('#nav-fwd'),
      toc: $('#toc'),
      tocInput: $('#toc-input'),
      tocBody: $('#toc-body'),
      search: $('#search'),
      searchInput: $('#search-input'),
      searchResults: $('#search-results'),
      menu: $('#sel-menu'),
      menuRef: $('#sel-ref'),
      menuColors: $('#sel-colors'),
      versePop: $('#verse-pop'),
    };
    this.bind();
  }

  // ------------------------------------------------------------------ Navigation
  async goto(ref, { push = true, flash = true } = {}) {
    const b = getBook(ref.book);
    if (!b) return;
    const pos = { book: b.id, chapter: Math.min(Math.max(ref.chapter || 1, 1), this.chapters(b.id)) };
    const same = pos.book === this.pos.book && pos.chapter === this.pos.chapter && this.verses.length;
    if (push) {
      this.history = this.history.slice(0, this.hIdx + 1);
      const last = this.history[this.hIdx];
      if (!last || last.book !== pos.book || last.chapter !== pos.chapter) {
        this.history.push(pos);
        this.hIdx = this.history.length - 1;
      }
    }
    this.pos = pos;
    if (!same) await this.render();
    else this.updateHeader();
    if (ref.vs) this.scrollToVerse(ref.vs, ref.ve || ref.vs, flash);
    else if (!same) this.el.scroll.scrollTop = 0;
    this.o.onNavigate?.(this.pos);
  }

  chapters(bookId) {
    return chapterCount(this.trans, bookId);
  }

  back() {
    if (this.hIdx > 0) this.goto(this.history[--this.hIdx], { push: false });
  }
  forward() {
    if (this.hIdx < this.history.length - 1) this.goto(this.history[++this.hIdx], { push: false });
  }
  step(dir) {
    let { book, chapter } = this.pos;
    chapter += dir;
    if (chapter < 1) {
      if (book === 1) return;
      book -= 1;
      chapter = this.chapters(book);
    } else if (chapter > this.chapters(book)) {
      if (book === 66) return;
      book += 1;
      chapter = 1;
    }
    this.goto({ book, chapter });
  }

  setTranslation(id) {
    this.trans = id;
    this.verses = [];
    return this.render();
  }

  setLayout(layout, font) {
    this.layout = layout;
    this.el.text.classList.toggle('lines', layout !== 'flow');
    this.el.text.classList.toggle('flow', layout === 'flow');
    this.el.text.classList.toggle('sans', font === 'sans');
  }

  updateHeader() {
    const b = getBook(this.pos.book);
    this.el.refLabel.textContent = `${b.name} ${this.pos.chapter}`;
    this.el.back.disabled = this.hIdx <= 0;
    this.el.fwd.disabled = this.hIdx >= this.history.length - 1;
    $('#ch-prev').disabled = this.pos.book === 1 && this.pos.chapter === 1;
    $('#ch-next').disabled = this.pos.book === 66 && this.pos.chapter === this.chapters(66);
  }

  // ------------------------------------------------------------------ Darstellung
  async render() {
    const token = ++this.renderToken;
    const { book, chapter } = this.pos;
    const b = getBook(book);
    this.clearSelection();
    this.updateHeader();
    const t = getTranslation(this.trans);
    this.el.text.innerHTML = `<p class="loading">Lade ${esc(b.name)} ${chapter} …</p>`;
    let verses = null;
    try {
      verses = await getChapter(this.trans, book, chapter);
    } catch (e) {
      console.error(e);
    }
    if (token !== this.renderToken) return;
    this.verses = verses || [];
    const head = `<p class="book-title">${esc(b.name)}</p><h1 class="chapter-title">Kapitel ${chapter}<small>${esc(t.short)}</small></h1>`;
    if (!verses || !verses.length) {
      this.el.text.innerHTML = `${head}<p class="missing">Dieses Kapitel ist in „${esc(t.name)}“ nicht enthalten.</p>`;
      return;
    }
    const heads = this.showHeadings ? getHeadings(this.trans, book, chapter) : new Map();
    const html = verses
      .map((txt, i) => {
        const h = heads.get(i + 1);
        const head = h ? `<h3 class="sec-head">${esc(h)}</h3>` : '';
        return txt ? `${head}<span class="v" data-v="${i + 1}"><sup class="vn">${i + 1}</sup>${esc(txt)}</span>` : head;
      })
      .join('');
    this.el.text.innerHTML = head + `<div class="verses">${html}</div>`;
    this.applyMarks();
    this.applyXrefs(token);
  }

  // ------------------------------------------------------------------ Querverweise
  async applyXrefs(token = this.renderToken) {
    $$('.vn.vn-x', this.el.text).forEach((n) => n.classList.remove('vn-x'));
    this.xrefs = new Map();
    if (!this.showXrefs) return;
    const map = await getXrefs(this.trans, this.pos.book, this.pos.chapter);
    if (token !== this.renderToken) return;
    this.xrefs = map;
    for (const [v, e] of map) {
      const marked = e.own.length || (this.xrefMode === 'all' ? e.ob.length : e.ob.some((c) => c[0] === '*'));
      if (!marked) continue;
      const vn = this.el.text.querySelector(`.v[data-v="${v}"] .vn`);
      if (vn) {
        vn.classList.add('vn-x');
        vn.title = 'Parallelstellen anzeigen';
      }
    }
  }

  setShowHeadings(on) {
    if (this.showHeadings === on) return;
    this.showHeadings = on;
    this.render();
  }

  setXrefMode(mode) {
    this.xrefMode = mode;
    this.showXrefs = mode !== 'off';
    this.applyXrefs();
  }

  async showXrefPop(v, anchor) {
    const pop = this.el.versePop;
    const entry = this.xrefs.get(v);
    if (!entry) return;
    const here = { book: this.pos.book, chapter: this.pos.chapter, vs: v };
    const item = (c) => {
      const r = parseCompact(c);
      const label = r.toChapter
        ? `${formatRef({ book: r.book, chapter: r.chapter, vs: r.vs })}–${r.toChapter},${r.toVerse}`
        : formatRef(r);
      return `<button class="xref" data-xref="${c}"><b>${esc(label)}</b><span class="xref-text">…</span></button>`;
    };
    const own = [...new Set(entry.own)];
    const ob = [...new Set(entry.ob)].filter((c) => !own.includes(c.replace(/^\*/, '')));
    const strong = ob.filter((c) => c[0] === '*');
    const weak = ob.filter((c) => c[0] !== '*');
    const group = (title, list) => (list.length ? `<div class="xref-group"><small>${title}</small>${list.map(item).join('')}</div>` : '');
    pop.innerHTML =
      `<h6>Parallelstellen zu ${esc(formatRef(here))}</h6>` +
      group(`Aus deiner ${esc(getTranslation(this.trans).short)}`, own) +
      group('Querverweise', strong) +
      group(strong.length || own.length ? 'Weitere' : 'Querverweise', weak) +
      `<p class="xref-credit">Querverweise: OpenBible.info (CC BY)</p>`;
    pop.classList.add('xref-pop');
    pop.classList.toggle('hidden', false);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    pop.style.left = `${Math.max(10, Math.min(r.left - 10, window.innerWidth - w - 10))}px`;
    pop.style.top = `${r.bottom + h + 16 > window.innerHeight ? Math.max(10, r.top - h - 8) : r.bottom + 8}px`;
    // Verstexte nachladen
    for (const btn of $$('.xref', pop)) {
      const ref = parseCompact(btn.dataset.xref);
      getChapter(this.trans, ref.book, ref.chapter)
        .then((verses) => {
          const span = btn.querySelector('.xref-text');
          if (!verses) {
            span.textContent = '';
            return;
          }
          let t;
          if (!ref.vs) t = verses.slice(0, 2).join(' ');
          else {
            const end = ref.toChapter ? verses.length : ref.ve;
            t = verses.slice(ref.vs - 1, Math.min(end, ref.vs + 2)).join(' ');
          }
          span.textContent = t.length > 230 ? t.slice(0, 228).replace(/\s\S*$/, '') + ' …' : t;
        })
        .catch(() => {});
    }
  }

  /** Markierungen und Notiz-Hinweise neu setzen, ohne den Text neu zu laden */
  applyMarks() {
    const root = this.el.text;
    for (const v of $$('.v', root)) {
      v.className = v.className.replace(/\bhl-\w+/g, '').trim();
    }
    $$('.note-mark', root).forEach((n) => n.remove());
    const marks = this.o.marksFor(this.pos.book, this.pos.chapter);
    // erst einfache Markierungen, dann Notiz-Markierungen (haben Vorrang)
    marks.sort((a, b) => (a.noteId ? 1 : 0) - (b.noteId ? 1 : 0));
    const notesAtVerse = new Map(); // ve -> [{noteId, noteTitle}]
    for (const m of marks) {
      for (let n = m.vs; n <= m.ve; n++) {
        const el = root.querySelector(`.v[data-v="${n}"]`);
        if (!el) continue;
        el.className = el.className.replace(/\bhl-\w+/g, '').trim();
        el.classList.add(`hl-${m.color || 'yellow'}`);
      }
      if (m.noteId) {
        const list = notesAtVerse.get(m.ve) || [];
        if (!list.some((x) => x.noteId === m.noteId)) list.push(m);
        notesAtVerse.set(m.ve, list);
      }
    }
    for (const [ve, list] of notesAtVerse) {
      const el = root.querySelector(`.v[data-v="${ve}"]`);
      if (!el) continue;
      const btn = document.createElement('button');
      btn.className = 'note-mark';
      btn.dataset.ve = ve;
      btn.title = list.map((x) => x.noteTitle || 'Notiz').join(', ');
      btn.innerHTML =
        list.length > 1
          ? String(list.length)
          : '<svg viewBox="0 0 24 24"><path d="M5 4h10l4 4v12H5z M14 4v5h5"/></svg>';
      btn._notes = list;
      el.appendChild(btn);
    }
  }

  scrollToVerse(vs, ve = vs, flash = true) {
    const first = this.el.text.querySelector(`.v[data-v="${vs}"]`);
    if (!first) return;
    const top = first.getBoundingClientRect().top - this.el.scroll.getBoundingClientRect().top + this.el.scroll.scrollTop;
    this.el.scroll.scrollTo({ top: Math.max(top - 90, 0), behavior: 'smooth' });
    if (flash) {
      for (let n = vs; n <= ve; n++) {
        const el = this.el.text.querySelector(`.v[data-v="${n}"]`);
        if (!el) continue;
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 1700);
      }
    }
  }

  verseText(vs, ve) {
    const out = [];
    for (let n = vs; n <= ve; n++) if (this.verses[n - 1]) out.push({ n, t: this.verses[n - 1] });
    return out;
  }

  // ------------------------------------------------------------------ Auswahl
  bind() {
    const { text, scroll } = this.el;
    this.el.back.onclick = () => this.back();
    this.el.fwd.onclick = () => this.forward();
    $('#ch-prev').onclick = () => this.step(-1);
    $('#ch-next').onclick = () => this.step(1);
    $('#ref-btn').onclick = () => this.openToc();
    $('#toc-close').onclick = () => this.closeToc();
    $('#btn-search').onclick = () => this.openSearch();
    $('#search-close').onclick = () => this.closeSearch();

    // Tippen auf einen Vers -> Vers auswählen (iPad-freundlich)
    text.addEventListener('click', (e) => {
      if (this.swallowClick && Date.now() - this.swallowClick < 800) {
        this.swallowClick = 0; // Tipp hat nur das Fenster geschlossen
        e.stopPropagation();
        return;
      }
      this.swallowClick = 0;
      const vnx = e.target.closest('.vn-x');
      if (vnx) {
        e.stopPropagation();
        this.clearSelection();
        this.showXrefPop(+vnx.closest('.v').dataset.v, vnx);
        return;
      }
      const mark = e.target.closest('.note-mark');
      if (mark) {
        e.stopPropagation();
        this.showVersePop(mark);
        return;
      }
      const s = window.getSelection();
      if (s && !s.isCollapsed && text.contains(s.anchorNode)) return; // echte Textauswahl
      const v = e.target.closest('.v');
      if (!v) return this.clearSelection();
      // Jeder Tipp nimmt den Vers dazu; ein ausgewählter Vers wird beim erneuten Tipp wieder abgewählt
      const n = +v.dataset.v;
      if (this.tapAnchor == null) this.tapSet = new Set(); // vorher Textauswahl -> neu anfangen
      this.tapAnchor = n;
      if (this.tapSet.has(n)) this.tapSet.delete(n);
      else this.tapSet.add(n);
      if (!this.tapSet.size) return this.clearSelection();
      this.setSelectionSet(this.tapSet);
    });

    // Echte Textauswahl (Maus oder Finger-Markierung)
    const fromNativeSelection = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed || !s.rangeCount) return;
      const r = s.getRangeAt(0);
      if (!text.contains(r.commonAncestorContainer)) return;
      const vEl = (node, offset, start) => {
        let el = node.nodeType === 3 ? node.parentElement : node;
        if (el === text || el.classList?.contains('verses')) {
          const child = el.childNodes[Math.max(0, offset - (start ? 0 : 1))];
          el = child?.nodeType === 1 ? child : child?.parentElement;
        }
        return el?.closest?.('.v');
      };
      const a = vEl(r.startContainer, r.startOffset, true);
      const b = vEl(r.endContainer, r.endOffset, false);
      const all = $$('.v', text);
      const va = a ? +a.dataset.v : all.length ? +all[0].dataset.v : null;
      const vb = b ? +b.dataset.v : va;
      if (va == null) return;
      this.tapAnchor = null;
      this.setSelection(Math.min(va, vb), Math.max(va, vb), true);
    };
    text.addEventListener('mouseup', () => setTimeout(fromNativeSelection, 0));
    text.addEventListener('touchend', () => setTimeout(fromNativeSelection, 350));
    let selTimer;
    document.addEventListener('selectionchange', () => {
      clearTimeout(selTimer);
      selTimer = setTimeout(() => {
        const s = window.getSelection();
        if (s && !s.isCollapsed && text.contains(s.anchorNode)) fromNativeSelection();
      }, 500);
    });

    // Native Drag & Drop am Desktop (markierten Text direkt ziehen)
    text.addEventListener('dragstart', (e) => {
      if (!this.sel) fromNativeSelection();
      if (!this.sel) return;
      const payload = this.selectionPayload();
      e.dataTransfer.setData('application/x-bibelstelle', JSON.stringify(payload));
      e.dataTransfer.setData('text/plain', `${payload.label}: ${payload.verses.map((v) => v.t).join(' ')}`);
      e.dataTransfer.effectAllowed = 'copy';
    });

    // Menü-Aktionen
    this.el.menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || !this.sel) return;
      const act = btn.dataset.act;
      if (act === 'drag') {
        this.o.toast?.('Halte „Ziehen“ gedrückt und zieh es aufs Notizfeld.');
        return;
      }
      if (act === 'color') return this.o.onAction(this.selectionPayload(), 'highlight', btn.dataset.color);
      this.o.onAction(this.selectionPayload(), act);
    });
    this.el.menu.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('[data-act="drag"]');
      if (!btn || !this.sel) return;
      e.preventDefault();
      this.o.onAction(this.selectionPayload(), 'drag', e);
    });
    this.el.menuColors.innerHTML =
      '<span>Markieren:</span>' +
      COLORS.map((c) => `<button class="swatch" data-act="color" data-color="${c.id}" title="${c.name}" style="background:${c.hex}"></button>`).join('') +
      '<button class="swatch none" data-act="color" data-color="none" title="Markierung entfernen"></button>';

    document.addEventListener('pointerdown', (e) => {
      const pop = this.el.versePop;
      if (!pop.contains(e.target) && !pop.classList.contains('hidden')) {
        // offenes Fenster (Parallelstellen/Notizen): dieser Tipp schließt nur das Fenster
        pop.classList.add('hidden');
        if (text.contains(e.target)) this.swallowClick = Date.now();
        return;
      }
      if (this.el.menu.contains(e.target) || text.contains(e.target)) return;
      if (e.target.closest('.drag-ghost')) return;
      this.hideMenu();
    });
    scroll.addEventListener('scroll', () => {
      if (!this.el.menu.classList.contains('hidden')) this.positionMenu();
      this.el.versePop.classList.add('hidden');
    }, { passive: true });

    this.el.versePop.addEventListener('click', (e) => {
      const x = e.target.closest('button[data-xref]');
      if (x) {
        this.el.versePop.classList.add('hidden');
        const r = parseCompact(x.dataset.xref);
        this.goto({ book: r.book, chapter: r.chapter, vs: r.vs, ve: r.toChapter ? undefined : r.ve });
        this.o.onXrefJump?.();
        return;
      }
      const b = e.target.closest('button[data-note]');
      if (!b) return;
      this.el.versePop.classList.add('hidden');
      this.o.onOpenNote(b.dataset.note, { jump: false });
    });

    // Tastatur: Pfeile links/rechts = Kapitel wechseln
    document.addEventListener('keydown', (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable) return;
      if (e.key === 'ArrowLeft') this.step(-1);
      if (e.key === 'ArrowRight') this.step(1);
      if (e.key === 'Escape') { this.clearSelection(); this.closeToc(); this.closeSearch(); }
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || e.key === 'g') { e.preventDefault(); this.openToc(); }
    });

    this.bindToc();
    this.bindSearch();
    this.bindPinch();
  }

  /**
   * Zwei Finger auseinander/zusammen = Schrift größer/kleiner. Der Browser-Zoom ist auf der
   * Bibelseite gesperrt, damit der Text immer sauber in der Spalte steht.
   */
  bindPinch() {
    const el = this.el.scroll;
    let pinch = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    el.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        pinch = { d: dist(e.touches), size: this.o.getBibleSize?.() || 19, last: null };
        e.preventDefault();
      }
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const size = Math.max(14, Math.min(30, Math.round(pinch.size * (dist(e.touches) / pinch.d))));
      if (size !== pinch.last) {
        pinch.last = size;
        this.o.onBibleSize?.(size, false);
      }
    }, { passive: false });
    const end = (e) => {
      if (!pinch || e.touches.length >= 2) return;
      if (pinch.last && pinch.last !== pinch.size) this.o.onBibleSize?.(pinch.last, true);
      pinch = null;
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    // Safari: eigene Zoom-Geste unterdrücken
    for (const type of ['gesturestart', 'gesturechange']) {
      document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
  }

  /** Auswahl aus einzelnen Versen (dürfen Lücken haben) */
  setSelectionSet(set) {
    const nums = [...set].sort((a, b) => a - b);
    const groups = [];
    for (const n of nums) {
      const g = groups[groups.length - 1];
      if (g && n === g[1] + 1) g[1] = n;
      else groups.push([n, n]);
    }
    this.setSelection(nums[0], nums[nums.length - 1], false, groups);
  }

  setSelection(vs, ve, native = false, groups = [[vs, ve]]) {
    if (native) this.tapSet = new Set();
    this.sel = { book: this.pos.book, chapter: this.pos.chapter, vs, ve, groups };
    $$('.v.sel', this.el.text).forEach((el) => el.classList.remove('sel'));
    if (!native) {
      for (const [a, b] of groups) for (let n = a; n <= b; n++) this.el.text.querySelector(`.v[data-v="${n}"]`)?.classList.add('sel');
    }
    this.el.menuRef.textContent = formatGroups(this.sel);
    this.el.menu.classList.remove('hidden');
    this.positionMenu();
  }

  /** Auswahl für Notizen/Markierungen: je zusammenhängender Abschnitt eine eigene Stelle */
  selectionPayload() {
    const s = this.sel;
    const transShort = getTranslation(this.trans).short;
    const parts = (s.groups || [[s.vs, s.ve]]).map(([vs, ve]) => ({
      book: s.book, chapter: s.chapter, vs, ve, trans: this.trans, transShort, verses: this.verseText(vs, ve),
    }));
    return { ...parts[0], vs: s.vs, ve: s.ve, parts, label: formatGroups(s), verses: parts.flatMap((p) => p.verses) };
  }

  positionMenu() {
    if (!this.sel) return;
    const m = this.el.menu;
    const last = this.el.text.querySelector(`.v[data-v="${this.sel.ve}"]`);
    const first = this.el.text.querySelector(`.v[data-v="${this.sel.vs}"]`);
    if (!last || !first) return;
    const r = last.getBoundingClientRect();
    const f = first.getBoundingClientRect();
    const pane = this.el.scroll.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    let left = Math.min(Math.max(pane.left + 10, r.left + 20), window.innerWidth - mw - 10);
    let top = r.bottom + 10;
    if (top + mh > window.innerHeight - 10) top = f.top - mh - 10; // passt nicht unten -> oben
    if (top < pane.top + 4) top = Math.min(window.innerHeight - mh - 10, Math.max(pane.top + 10, r.bottom + 10));
    m.style.left = `${left}px`;
    m.style.top = `${top}px`;
  }

  hideMenu() {
    this.el.menu.classList.add('hidden');
  }

  clearSelection() {
    this.sel = null;
    this.tapAnchor = null;
    this.tapSet = new Set();
    this.hideMenu();
    $$('.v.sel', this.el.text).forEach((el) => el.classList.remove('sel'));
    const s = window.getSelection();
    if (s && !s.isCollapsed && this.el.text.contains(s.anchorNode)) s.removeAllRanges();
  }

  showVersePop(markBtn) {
    const pop = this.el.versePop;
    const list = markBtn._notes || [];
    pop.classList.toggle('xref-pop', false);
    pop.innerHTML =
      `<h6>Notizen zu dieser Stelle</h6>` +
      list.map((m) => `<button data-note="${m.noteId}">${esc(m.noteTitle || 'Unbenannte Notiz')}<br><small style="color:var(--text-3)">${esc(formatRef({ book: this.pos.book, chapter: this.pos.chapter, vs: m.vs, ve: m.ve }))}</small></button>`).join('');
    pop.classList.remove('hidden');
    const r = markBtn.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(10, Math.min(r.left - w / 2, window.innerWidth - w - 10))}px`;
    pop.style.top = `${Math.min(r.bottom + 8, window.innerHeight - pop.offsetHeight - 10)}px`;
  }

  // ------------------------------------------------------------------ Inhaltsverzeichnis
  openToc() {
    this.closeSearch();
    this.el.toc.classList.add('open');
    this.el.tocInput.value = '';
    this.renderBooks();
    // nur mit Maus/Tastatur direkt ins Eingabefeld – auf dem iPad würde sonst die Tastatur die Bücher verdecken
    if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => this.el.tocInput.focus({ preventScroll: true }), 30);
  }
  closeToc() {
    this.el.toc.classList.remove('open');
  }

  bindToc() {
    const input = this.el.tocInput;
    input.addEventListener('input', () => this.renderBooks(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const r = parseRef(input.value);
        if (r) {
          this.closeToc();
          this.goto(r);
        }
      }
    });
    this.el.tocBody.addEventListener('click', (e) => {
      const bk = e.target.closest('[data-book]');
      const ch = e.target.closest('[data-chapter]');
      const go = e.target.closest('[data-go]');
      if (go) {
        const r = parseRef(input.value);
        if (r) { this.closeToc(); this.goto(r); }
        return;
      }
      if (ch) {
        this.closeToc();
        this.goto({ book: +ch.dataset.b, chapter: +ch.dataset.chapter });
      } else if (bk) {
        const b = getBook(+bk.dataset.book);
        if (this.chapters(b.id) === 1) {
          this.closeToc();
          this.goto({ book: b.id, chapter: 1 });
        } else this.renderChapters(b.id);
      } else if (e.target.closest('[data-back]')) this.renderBooks(input.value);
    });
  }

  renderBooks(filter = '') {
    const q = filter.trim();
    const r = q ? parseRef(q) : null;
    const preview = r
      ? `<div class="toc-preview">Enter drücken für <b data-go style="cursor:pointer">${esc(formatRef(r))}</b></div>`
      : `<div class="toc-preview">Tipp: Stelle eintippen und Enter drücken – oder Buch wählen.</div>`;
    const lower = q.toLowerCase().replace(/[\d.\s,:-]+$/, '');
    const match = (b) => !lower || b.name.toLowerCase().replace(/\s/g, '').includes(lower.replace(/\s/g, '')) || b.abbr.toLowerCase().startsWith(lower.replace(/\s/g, ''));
    const section = (title, list) =>
      list.length
        ? `<div class="toc-section"><h4>${title}</h4><div class="book-grid">${list
            .map((b) => `<button class="book-btn${b.id === this.pos.book ? ' current' : ''}" data-book="${b.id}"><b>${esc(b.name)}</b><span>${b.abbr} · ${this.chapters(b.id)} Kap.</span></button>`)
            .join('')}</div></div>`
        : '';
    const at = BOOKS.filter((b) => b.testament === 'AT' && match(b));
    const nt = BOOKS.filter((b) => b.testament === 'NT' && match(b));
    this.el.tocBody.innerHTML = preview + section('Altes Testament', at) + section('Neues Testament', nt);
  }

  renderChapters(bookId) {
    const b = getBook(bookId);
    const withNotes = this.o.chaptersWithNotes(bookId);
    let html = `<div class="toc-chapters-head"><button class="icon-btn" data-back aria-label="Zurück"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button><h3>${esc(b.name)}</h3></div><div class="chapter-grid">`;
    for (let c = 1; c <= this.chapters(b.id); c++) {
      const cur = b.id === this.pos.book && c === this.pos.chapter;
      html += `<button class="ch-btn${cur ? ' current' : ''}${withNotes.has(c) ? ' has-notes' : ''}" data-b="${b.id}" data-chapter="${c}">${c}</button>`;
    }
    this.el.tocBody.innerHTML = html + '</div>';
    this.el.tocBody.scrollTop = 0;
  }

  // ------------------------------------------------------------------ Suche
  openSearch() {
    this.closeToc();
    this.el.search.classList.add('open');
    setTimeout(() => this.el.searchInput.focus({ preventScroll: true }), 30);
  }
  closeSearch() {
    this.el.search.classList.remove('open');
  }

  bindSearch() {
    let timer;
    this.el.searchInput.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => this.runSearch(), 350);
    });
    this.el.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(timer); this.runSearch(); }
    });
    $('#search-filter').addEventListener('click', (e) => {
      const c = e.target.closest('[data-scope]');
      if (!c) return;
      $$('#search-filter .chip').forEach((x) => x.classList.toggle('active', x === c));
      this.searchScope = c.dataset.scope;
      this.runSearch();
    });
    this.el.searchResults.addEventListener('click', (e) => {
      const r = e.target.closest('[data-ref]');
      if (!r) return;
      const [book, chapter, vs] = r.dataset.ref.split(':').map(Number);
      this.closeSearch();
      this.goto({ book, chapter, vs, ve: vs });
    });
  }

  async runSearch() {
    const q = this.el.searchInput.value.trim();
    const out = this.el.searchResults;
    if (q.length < 2) {
      out.innerHTML = '<div class="search-info">Mindestens 2 Zeichen eingeben.</div>';
      return;
    }
    const token = (this.searchToken = (this.searchToken || 0) + 1);
    out.innerHTML = '<div class="search-info">Suche …</div>';
    const books = BOOKS.filter((b) =>
      this.searchScope === 'all' ? true : this.searchScope === 'book' ? b.id === this.pos.book : b.testament === this.searchScope
    );
    const needle = q.toLowerCase();
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const results = [];
    let total = 0;
    const LIMIT = 400;
    for (let i = 0; i < books.length; i += 6) {
      const chunk = books.slice(i, i + 6);
      const datas = await Promise.all(chunk.map((b) => getBookData(this.trans, b.id).catch(() => null)));
      if (token !== this.searchToken) return;
      chunk.forEach((b, j) => {
        const data = datas[j];
        if (!data) return;
        data.forEach((ch, ci) =>
          ch?.forEach((t, vi) => {
            if (t && t.toLowerCase().includes(needle)) {
              total++;
              if (results.length < LIMIT) results.push({ book: b.id, chapter: ci + 1, vs: vi + 1, t });
            }
          })
        );
      });
    }
    if (token !== this.searchToken) return;
    if (!total) {
      out.innerHTML = `<div class="search-info">Keine Treffer für „${esc(q)}“.</div>`;
      return;
    }
    out.innerHTML =
      `<div class="search-info">${total} Treffer${total > LIMIT ? ` – die ersten ${LIMIT} werden angezeigt` : ''}</div>` +
      results
        .map(
          (r) =>
            `<div class="result" data-ref="${r.book}:${r.chapter}:${r.vs}"><b>${esc(formatRef(r))}</b><span>${esc(r.t).replace(rx, (m) => `<mark>${m}</mark>`)}</span></div>`
        )
        .join('');
  }
}

/** „Johannes 3,16.18-19“ – Stelle mit mehreren Abschnitten */
export function formatGroups(sel) {
  const groups = sel.groups || [[sel.vs, sel.ve]];
  const first = formatRef({ book: sel.book, chapter: sel.chapter, vs: groups[0][0], ve: groups[0][1] });
  return [first, ...groups.slice(1).map(([a, z]) => (a === z ? `${a}` : `${a}-${z}`))].join('.');
}
