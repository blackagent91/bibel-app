// PDF-Import: liest eine Bibel aus einem PDF (z. B. Schlachter 2000) direkt im Browser aus.
// Erkennt Buchtitel (große Schrift), Kapitelanfänge (große Zahl / „Psalm N“),
// Versnummern, und überspringt Kopfzeilen, Zwischenüberschriften, Parallelstellen und Fußnoten.
// Die Datei verlässt das Gerät nicht.
import { BOOKS, parseRefList } from './books.js';

let pdfjsPromise = null;
function loadPdfJs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = new Promise((resolve, reject) => {
    if (window.pdfjsLib) return resolve(window.pdfjsLib);
    const s = document.createElement('script');
    s.src = 'vendor/pdfjs/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('PDF-Leser konnte nicht geladen werden.'));
    document.head.append(s);
  });
  return pdfjsPromise;
}

// ---------------------------------------------------------------------------
// Buchtitel erkennen
// ---------------------------------------------------------------------------
const TITLE_PATTERNS = [
  [/mose/, [1, 2, 3, 4, 5]],
  [/josua/, 6],
  [/richter/, 7],
  [/\brut(h)?\b/, 8],
  [/samuel/, [9, 10]],
  [/k(ö|oe)nige/, [11, 12]],
  [/chronik/, [13, 14]],
  [/\besra\b/, 15],
  [/nehemia/, 16],
  [/est(h)?er/, 17],
  [/hiob|ijob/, 18],
  [/psalm/, 19],
  [/spr(ü|ue)che/, 20],
  [/prediger|kohelet/, 21],
  [/hohe(s)?lied|lied der lieder/, 22],
  [/jesaja/, 23],
  [/klagelieder/, 25],
  [/jeremia/, 24],
  [/hesekiel|ezechiel/, 26],
  [/daniel/, 27],
  [/hosea/, 28],
  [/\bjoel\b/, 29],
  [/\bamos\b/, 30],
  [/obadja/, 31],
  [/\bjona\b/, 32],
  [/micha\b/, 33],
  [/nahum/, 34],
  [/habakuk/, 35],
  [/ze(ph|f)anja/, 36],
  [/haggai/, 37],
  [/sacharja/, 38],
  [/maleachi/, 39],
  [/matth(ä|ae)us/, 40],
  [/markus/, 41],
  [/lukas/, 42],
  [/apostelgeschichte/, 44],
  [/r(ö|oe)mer/, 45],
  [/korinther/, [46, 47]],
  [/galater/, 48],
  [/epheser/, 49],
  [/philipper/, 50],
  [/kolosser/, 51],
  [/thessalonicher/, [52, 53]],
  [/timotheus/, [54, 55]],
  [/\btitus\b/, 56],
  [/philemon/, 57],
  [/hebr(ä|ae)er/, 58],
  [/jakobus/, 59],
  [/petrus/, [60, 61]],
  // Offenbarung vor Johannes prüfen: der Titel lautet oft „Die Offenbarung des Johannes“
  [/offenbarung|apokalypse/, 66],
  [/brief.*johannes|johannes.*brief/, [62, 63, 64]],
  [/johannes/, 43],
  [/judas/, 65],
];

const LIGATURES = { '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi', '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st' };
export const fixLigatures = (t) => t.replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c]);

export function matchBookTitle(title) {
  const s =
    ' ' +
    fixLigatures(title)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      // beim Auslesen auseinandergerissene Ligaturen wieder zusammenfügen („o ff enbarung“)
      .replace(/([a-zäöüß]) ?(ffi|ffl|ff|fi|fl) ?([a-zäöüß])/g, '$1$2$3') +
    ' ';
  return matchIn(s, s);
}

function matchIn(s, hay) {
  let ord = 1;
  if (/\b(zweite|2\.)/.test(s)) ord = 2;
  else if (/\b(dritte|3\.)/.test(s)) ord = 3;
  else if (/\b(vierte|4\.)/.test(s)) ord = 4;
  else if (/\b(f(ü|ue)nfte|5\.)/.test(s)) ord = 5;
  for (const [rx, id] of TITLE_PATTERNS) {
    if (rx.test(hay)) return Array.isArray(id) ? id[Math.min(ord, id.length) - 1] : id;
  }
  return 0;
}

// Liste von Parallelstellen, z. B. „Neh 9,6; Ps 124,8; Joh 1,1-3“ oder „1Mo 5; 1Mo 10 u. 11“
const HYPHEN_END = /[-\u00AD\u2010\u2011]\s*$/;

const REF_LIST = /^(\s*(\d\s?)?[A-ZÄÖÜ][a-zäöü]{0,6}\.?\s?\d+(,\s?\d+[a-z]?)?([-–.]\s?\d+[a-z]?)*(\s?(u\.|f+\.?)\s?\d*)?\s*[;,.]?)+\s*$/;

/** Weighted mode (häufigster Wert, gewichtet nach Zeichenanzahl) */
function weightedMode(entries) {
  const m = new Map();
  for (const [k, w] of entries) m.set(k, (m.get(k) || 0) + w);
  let best = null;
  let bw = -1;
  for (const [k, w] of m) if (w > bw) { best = k; bw = w; }
  return best;
}

/**
 * @param {File} file
 * @param {(info:{page:number, pages:number, book:number}) => void} onProgress
 * @param {{cancelled:boolean}} signal
 */
export async function parseBiblePdf(file, onProgress = () => {}, signal = {}) {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;

  let meta = {};
  try { meta = (await pdf.getMetadata())?.info || {}; } catch {}

  // Vorlage: Kapitel- und Verszahlen jedes Buches (aus der eingebauten Elberfelder).
  // Damit werden Kapitel- und Buchwechsel geprüft – Übersetzungen weichen nur minimal ab.
  let VC = null;
  try { VC = await (await fetch('data/versecounts.json')).json(); } catch {}
  const expVerses = (b, c) => VC?.[b - 1]?.[c - 1] || 0;
  const maxChapters = (b) => (b === 29 ? 4 : BOOKS[b - 1].chapters); // Joel: 3 oder 4 Kapitel

  const books = [];
  const xrefs = {}; // "Buch:Kapitel:Vers" -> ["43.15.18-19", …] (Stellen unter den Zwischenüberschriften)
  let pendingRefs = [];
  const notes = { unmatched: [], skipped: [], fallbacks: [], starts: [] }; // für den Prüfbericht
  const sizeChars = new Map(); // Schriftgröße -> Anzahl Zeichen (ganzes Dokument)
  let sizeTotal = 0;
  let pageNo = 0;
  const st = {
    book: 0,
    chapter: 0,
    verse: 0,
    provisional: false, // Text vor dem ersten Kapitelanfang eines Buches (für einkapitelige Bücher)
    buf: '',
    inHeading: false,
  };

  const flush = () => {
    if (!st.book || !st.chapter || st.verse < 1) return;
    const t = st.buf.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    if (!t) return;
    const b = (books[st.book - 1] ||= []);
    const c = (b[st.chapter - 1] ||= []);
    c[st.verse - 1] = c[st.verse - 1] ? c[st.verse - 1] + ' ' + t : t;
  };
  const attachRefs = () => {
    if (!pendingRefs.length || !st.book || !st.chapter || st.verse < 1) return;
    const key = `${st.book}:${st.chapter}:${st.verse}`;
    xrefs[key] = [...new Set([...(xrefs[key] || []), ...pendingRefs])];
    pendingRefs = [];
  };
  const setVerse = (v) => {
    flush();
    st.verse = v;
    st.buf = '';
    st.bounds = [];
    attachRefs();
  };
  /**
   * Zweite Kapitelerkennung: Die Versnummer springt zurück auf 2 (Vers 1 steht unnummeriert
   * neben der großen Kapitelzahl) bzw. auf 1. Dann beginnt hier ein neues Kapitel – auch wenn
   * die große Kapitelzahl im PDF nicht als Text lesbar war.
   */
  const chapterReset = (n) => {
    const exp = expVerses(st.book, st.chapter);
    const needed = exp ? Math.max(3, Math.floor(exp * 0.6)) : 3;
    if (st.verse < needed) return false; // mitten im Kapitel -> kein Kapitelwechsel
    let oldPart = st.buf;
    let v1 = '';
    if (n === 2) {
      // zuverlässigste Art von Hinweis wählen; davon die erste Stelle (bei „Satzende“ die letzte)
      const best = Math.max(-1, ...st.bounds.map((b) => b.tier));
      const cands = st.bounds.filter((b) => b.tier === best);
      const cut = !cands.length ? -1 : best > 0 ? cands[0].pos : cands[cands.length - 1].pos;
      if (cut >= 0) {
        oldPart = st.buf.slice(0, cut);
        v1 = st.buf.slice(cut).trim();
      }
    }
    st.buf = oldPart;
    flush();
    st.buf = '';
    if (st.chapter + 1 > maxChapters(st.book) && st.book < 66) {
      // Buch ist voll -> das ist der Anfang des nächsten Buches (Titel war nicht lesbar)
      const next = st.book + 1;
      notes.fallbacks.push(`Seite ${pageNo}: „${BOOKS[st.book - 1].name}“ hat alle Kapitel → weiter mit „${BOOKS[next - 1].name}“`);
      startBook(next, 'über die Kapitelzahl erkannt');
      if (next === 19) return true; // Psalmen beginnen mit „Psalm 1“
      st.chapter = 0;
    }
    st.chapter += 1;
    st.verse = 1;
    st.buf = v1.replace(new RegExp('^' + st.chapter + '(?!\\d)\\s*'), ''); // evtl. mitgelesene Kapitelzahl entfernen
    st.bounds = [];
    st.provisional = false;
    notes.resets = (notes.resets || 0) + 1;
    setVerse(n);
    return true;
  };
  const append = (text) => {
    if (!st.book || !st.chapter || st.verse < 1 || !text) return;
    const b = st.buf;
    const t = text.trimStart();
    if (!b) st.buf = t;
    else if (HYPHEN_END.test(b) && /^[a-zäöüß]/.test(t) && !/^(und|oder|bzw|bis|sowie)\b/.test(t)) st.buf = b.replace(HYPHEN_END, '') + t; // Silbentrennung
    else if (HYPHEN_END.test(b)) st.buf = b.replace(/[\u00AD\s]+$/, '').replace(/[\u2010\u2011]$/, '-') + t; // echter Bindestrich
    else st.buf = b.replace(/\s+$/, '') + ' ' + t;
  };
  const startBook = (id, how = '') => {
    flush();
    books[id - 1] = undefined; // falls das Buch vorher fälschlich begonnen wurde: frisch anfangen
    notes.starts.push(`${BOOKS[id - 1].name} – S. ${pageNo}${how ? ` (${how})` : ''}`);
    st.book = id;
    st.chapter = 1;
    st.verse = id === 19 ? 0 : 1;
    st.provisional = true;
    st.buf = '';
    st.inHeading = false;
    st.suspended = false;
    pendingRefs = [];
  };
  const startChapter = (n, firstVerse = 1) => {
    if (st.provisional) st.buf = ''; // Text vor dem ersten Kapitelanfang verwerfen
    flush();
    st.chapter = n;
    st.verse = firstVerse;
    st.buf = '';
    st.provisional = false;
    st.inHeading = false;
    st.suspended = false;
    attachRefs();
  };

  for (let pn = 1; pn <= pdf.numPages; pn++) {
    if (signal.cancelled) throw new Error('Import abgebrochen.');
    const page = await pdf.getPage(pn);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    page.cleanup();
    pageNo = pn;
    processPage(tc.items, vp.width);
    if (pn % 5 === 0 || pn === pdf.numPages) {
      onProgress({ page: pn, pages: pdf.numPages, book: st.book });
      await new Promise((r) => setTimeout(r, 0)); // Oberfläche reagieren lassen
    }
  }
  flush();
  pdf.destroy();

  // --- Ergebnis aufbereiten
  const out = [];
  for (let i = 0; i < 66; i++) {
    const b = books[i];
    if (!b) { out.push(null); continue; }
    for (let c = 0; c < b.length; c++) {
      b[c] = b[c] || [];
      for (let v = 0; v < b[c].length; v++) if (b[c][v] == null) b[c][v] = '';
    }
    out.push(b);
  }
  const xrefCount = Object.values(xrefs).reduce((n, l) => n + l.length, 0);
  if (notes.resets) notes.fallbacks.push(`${notes.resets} Kapitelanfänge über die Versnummern erkannt (die große Kapitelzahl war im PDF nicht lesbar)`);
  const deviations = [];
  if (VC) {
    out.forEach((b, i) => {
      if (!b) return;
      b.forEach((c, ci) => {
        const exp = VC[i][ci];
        const got = (c || []).filter(Boolean).length;
        if (exp && Math.abs(got - exp) > 2) deviations.push({ book: i + 1, chapter: ci + 1, got, exp });
      });
    });
  }
  return {
    name: guessName(meta, file.name),
    books: out,
    xrefs,
    report: { ...buildReport(out), ...notes, xrefs: xrefCount, deviations },
  };

  // -------------------------------------------------------------------------
  function processPage(rawItems, pageWidth) {
    const items = [];
    for (const it of rawItems) {
      if (!it.str) continue;
      const t = it.transform;
      const size = Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
      items.push({ s: fixLigatures(it.str), x: t[4], y: t[5], w: it.width, size, font: it.fontName });
    }
    const textItems = items.filter((i) => i.s.trim());
    if (!textItems.length) return;

    // Normale Schriftgröße über das ganze Dokument bestimmen (eine Seite mit wenig Bibeltext und
    // langer Fußnote würde sonst die Fußnotenschrift für den Fließtext halten)
    const pageSizes = textItems.map((i) => [Math.round(i.size * 2) / 2, i.s.length]);
    for (const [k, w] of pageSizes) {
      sizeChars.set(k, (sizeChars.get(k) || 0) + w);
      sizeTotal += w;
    }
    const body = sizeTotal > 4000 ? weightedMode([...sizeChars]) : weightedMode(pageSizes);
    const bodyFont = weightedMode(
      textItems.filter((i) => Math.abs(i.size - body) < 0.6).map((i) => [i.font, i.s.length])
    );

    // Klassifizieren
    const titles = [];
    const drops = [];
    const normal = [];
    for (const i of items) {
      const rel = i.size / body;
      const tr = i.s.trim();
      if (rel > 1.25 && /^\d{1,3}$/.test(tr)) drops.push(i);
      else if (rel > 1.3 && tr) titles.push(i);
      else normal.push(i);
    }
    // Große Schrift, die kein mittig gesetzter Titel ist (z. B. Initialen in der Spalte), als Text behandeln
    if (titles.length) {
      const cx = titles.reduce((a, i) => a + i.x + i.w / 2, 0) / titles.length;
      const letters = titles.map((i) => i.s).join('').replace(/[^A-Za-zÄÖÜäöüß]/g, '').length;
      if (Math.abs(cx - pageWidth / 2) > pageWidth * 0.2 || letters < 4) {
        normal.push(...titles);
        titles.length = 0;
      }
    }

    // Kopfzeile (Seitenzahl + Buch + Kapitel) oben entfernen
    const sorted = normal.filter((i) => i.s.trim()).sort((a, b) => b.y - a.y);
    if (sorted.length) {
      const topY = sorted[0].y;
      const row = sorted.filter((i) => Math.abs(i.y - topY) < body * 0.5);
      const below = sorted.find((i) => topY - i.y > body * 0.5);
      const gap = below ? topY - below.y : Infinity;
      const text = row.sort((a, b) => a.x - b.x).map((i) => i.s.trim()).join(' ');
      const higherThanTitle = !titles.length || topY > Math.max(...titles.map((t) => t.y));
      if (higherThanTitle && gap > body * 1.6 && text.length < 60 && /[A-Za-zÄÖÜ]/.test(text) && /(^\d+\s)|(\s\d+$)|\d+\.\d+/.test(text)) {
        for (const i of row) normal.splice(normal.indexOf(i), 1);
      }
    }

    // Buchtitel (kann über mehrere Zeilen gehen). Text oberhalb des Titels gehört noch
    // zum vorigen Buch, Text darunter zum neuen.
    let titleId = 0;
    let titleTop = -Infinity;
    if (titles.length) {
      titleId = matchBookTitle(joinText(titles));
      titleTop = Math.max(...titles.map((i) => i.y + i.size));
    }
    if (titleId && titleId !== st.book) {
      if (titleId < st.book) {
        notes.fallbacks.push(`Seite ${pageNo}: Titel „${BOOKS[titleId - 1].name}“ nach „${BOOKS[st.book - 1].name}“ gefunden – Zuordnung korrigiert`);
      }
      const above = (i) => i.y > titleTop;
      processRegion(normal.filter(above), drops.filter(above), pageWidth, body, bodyFont);
      startBook(titleId);
      const below = (i) => i.y <= titleTop;
      processRegion(normal.filter(below), drops.filter(below), pageWidth, body, bodyFont);
      return;
    }
    if (titles.length && !titleId) {
      const t = joinText(titles);
      const above = (i) => i.y > titleTop;
      // Text oberhalb der Überschrift gehört noch zum laufenden Buch
      processRegion(normal.filter(above), drops.filter(above), pageWidth, body, bodyFont);
      const label = st.book === 66 || !st.book ? 'skipped' : 'unmatched';
      if (t && notes[label].length < 25) notes[label].push(`Seite ${pageNo}: „${t.slice(0, 80)}“`);
      // Anhang/Vorwort o. Ä.: ab hier nichts mehr an Verse anhängen, bis ein Buch/Kapitel beginnt
      flush();
      st.suspended = true;
      st.buf = '';
      const below = (i) => i.y <= titleTop;
      processRegion(normal.filter(below), drops.filter(below), pageWidth, body, bodyFont);
      return;
    }
    if (titleId && titleId > st.book) {
      const above = (i) => i.y > titleTop;
      processRegion(normal.filter(above), drops.filter(above), pageWidth, body, bodyFont);
      startBook(titleId);
      const below = (i) => i.y <= titleTop;
      processRegion(normal.filter(below), drops.filter(below), pageWidth, body, bodyFont);
    } else {
      processRegion(normal, drops, pageWidth, body, bodyFont);
    }
  }

  function processRegion(normal, drops, pageWidth, body, bodyFont) {
    // Spalten trennen und Zeilen bilden
    const mid = pageWidth / 2;
    for (const col of [0, 1]) {
      const inCol = (i) => (i.x + Math.max(i.w, 1) / 2 < mid ? 0 : 1) === col;
      const lines = [];
      for (const i of normal.filter(inCol).sort((a, b) => b.y - a.y || a.x - b.x)) {
        let line = lines.find((l) => Math.abs(l.y - i.y) < body * 0.45);
        if (!line) lines.push((line = { y: i.y, items: [], key: i.y }));
        line.items.push(i);
      }
      for (const d of drops.filter(inCol)) lines.push({ drop: d, key: d.y + d.size * 0.72 });
      lines.sort((a, b) => b.key - a.key);

      // typischer Zeilenabstand in dieser Spalte
      const gaps = [];
      let prevY = null;
      for (const l of lines) {
        if (l.drop) continue;
        if (prevY != null) gaps.push(Math.round((prevY - l.y) * 2) / 2);
        prevY = l.y;
      }
      const spacing = gaps.length ? weightedMode(gaps.filter((g) => g > 0).map((g) => [g, 1])) || body * 1.2 : body * 1.2;
      // linker Spaltenrand (häufigster Zeilenanfang)
      const starts = lines.filter((l) => !l.drop).map((l) => [Math.round(Math.min(...l.items.map((i) => i.x))), 1]);
      const colLeft = starts.length ? weightedMode(starts) : 0;

      prevY = null;
      for (const l of lines) {
        if (l.drop) {
          handleDrop(parseInt(l.drop.s.trim(), 10));
          continue;
        }
        const gapBefore = prevY == null ? Infinity : prevY - l.y;
        prevY = l.y;
        handleLine(l, gapBefore, spacing, body, bodyFont, colLeft);
      }
    }
  }

  function handleDrop(n) {
    if (!st.book) return;
    if (st.provisional && st.book !== 19 && n <= 3) return startChapter(n, 1);
    // Absicherung: neues „Kapitel 1“ ohne erkannten Buchtitel -> nächstes Buch der Bibel
    if (st.suspended && st.book === 66) return; // Anhang nach der Offenbarung
    const wellUnderway = st.chapter > 1 || st.verse >= 6;
    if (n === 1 && st.chapter === 1 && !wellUnderway) return startChapter(1, 1); // Kapitel 1 erst jetzt richtig begonnen
    if (n === 1 && st.book < 66 && wellUnderway) {
      const next = st.book + 1;
      notes.fallbacks.push(`Seite ${pageNo}: Buchanfang ohne erkannten Titel → als „${BOOKS[next - 1].name}“ eingeordnet`);
      startBook(next, 'ohne Titel erkannt');
      if (next !== 19) startChapter(1, 1);
      return;
    }
    if (st.book === 19) return; // Psalmen beginnen mit „Psalm N“
    if (n > st.chapter && n <= st.chapter + 3) startChapter(n, 1);
  }

  function handleLine(line, gapBefore, spacing, body, bodyFont, colLeft = 0) {
    if (st.suspended) return;
    const skipped = () => {
      st.skippedSince = true; // Überschrift o. Ä. übersprungen -> danach beginnt oft ein neuer Abschnitt
    };
    const items = line.items.sort((a, b) => a.x - b.x);
    const normalItems = items.filter((i) => i.size >= body * 0.88 && i.s.trim());
    const baseline = normalItems.length ? Math.min(...normalItems.map((i) => i.y)) : line.y;
    const chars = items.reduce((n, i) => n + i.s.trim().length, 0);
    if (!chars) return;
    // Zeile überwiegend kleine Schrift -> Fußnoten / Parallelstellen
    const smallChars = items.filter((i) => i.size < body * 0.88).reduce((n, i) => n + i.s.trim().length, 0);
    if (smallChars / chars > 0.6) {
      const t = joinText(items);
      if (REF_LIST.test(t)) pendingRefs.push(...parseRefList(t));
      skipped();
      return;
    }

    // Segmente bauen (hochgestellte Fußnotenzeichen weglassen)
    const segs = [];
    let lastEnd = null;
    for (const i of items) {
      const small = i.size < body * 0.88;
      const raised = i.y - baseline > body * 0.2;
      if (small && raised && /^[a-z*†\d]{1,2}$/.test(i.s.trim())) continue; // Fußnotenzeichen
      let s = i.s;
      if (lastEnd != null && i.x - lastEnd > body * 0.12 && !/\s$/.test(segs[segs.length - 1]?.s || '') && !/^\s/.test(s)) {
        segs.push({ s: ' ', font: bodyFont, space: true });
      }
      segs.push({ s, font: i.font, small });
      lastEnd = i.x + i.w;
    }
    const text = segs.map((g) => g.s).join('').replace(/\s+/g, ' ').trim();
    if (!text) return;

    // Psalm-Überschrift „Psalm 23“
    const ps = text.match(/^Psalm\s+(\d{1,3})\s*$/);
    if (ps && st.book === 19) {
      const n = parseInt(ps[1], 10);
      if (n >= st.chapter && n <= st.chapter + 3) startChapter(n, 0);
      st.inHeading = false;
      return;
    }
    // Abschnittsangaben überspringen
    if (/^\(?\s*(Kapitel|Psalm(en)?)\s+\d+(\s*[-–]\s*\d+)?\s*\)?$/.test(text)) return;
    const letters = text.replace(/[^A-Za-zÄÖÜäöüß]/g, '');
    if (letters.length >= 6 && letters === letters.toUpperCase()) {
      st.inHeading = true;
      skipped();
      return;
    }
    // Zwischenüberschrift: ganze Zeile in anderer Schrift als der Fließtext, mit Abstand davor
    const realSegs = segs.filter((g) => !g.space && g.s.trim());
    const allOther = realSegs.length && realSegs.every((g) => g.font !== bodyFont);
    if (allOther && !/^\d/.test(text) && (gapBefore > spacing * 1.4 || st.inHeading)) {
      st.inHeading = true;
      skipped();
      return;
    }
    if (REF_LIST.test(text)) {
      // Parallelstellen („2Kor 1,1-2; Kol 1,3“) – nie Verstext, und ihre Zahlen sind keine Versnummern.
      // Sie werden als Querverweise für den folgenden Vers gemerkt.
      pendingRefs.push(...parseRefList(text));
      st.inHeading = false;
      skipped();
      return;
    }
    st.inHeading = false;
    // Mögliche Stelle für einen neuen Vers 1: nach einer Überschrift, eingerückt (neben der
    // großen Kapitelzahl) oder nach einem größeren Abstand
    const indent = Math.min(...items.map((i) => i.x)) - colLeft > body * 1.2;
    st.boundaryTier = st.skippedSince ? 3 : indent ? 2 : gapBefore > spacing * 1.6 ? 1 : 0;
    st.skippedSince = false;

    // Versnummern finden
    let first = true;
    for (const g of segs) {
      if (g.space) {
        appendRaw(' ');
        continue;
      }
      let s = g.s;
      const m = s.match(/^\s*(\d{1,3})(?!\d)\s*(.*)$/s);
      if (m) {
        const n = parseInt(m[1], 10);
        const expected = st.verse + 1;
        const plausible = n >= expected && n <= expected + 2;
        const marked = g.font !== bodyFont || first;
        if (plausible && marked && st.chapter) {
          if (st.provisional && st.verse <= 1 && n >= 2) st.provisional = false;
          setVerse(n);
          s = m[2];
        } else if (
          !plausible && st.chapter && g.font !== bodyFont && st.verse >= 3 &&
          (n === 1 || (n === 2 && st.book !== 19))
        ) {
          if (chapterReset(n)) s = m[2];
        }
      }
      first = false;
      if (s) appendRaw(s);
    }
    appendRaw('\n');
  }

  // Zeilen eines Verses zusammensetzen (Silbentrennung am Zeilenende auflösen)
  function appendRaw(s) {
    if (s === '\n') {
      st.lineBreak = true;
      return;
    }
    if (st.lineBreak) {
      st.lineBreak = false;
      if (st.buf) {
        let tier = st.boundaryTier || 0;
        // schwächster Hinweis: vorige Zeile endet mit Satzende, neue beginnt groß
        if (!tier && !(/[.!?»“"]\s*$/.test(st.buf) && /^\s*[A-ZÄÖÜ»„"]/.test(s))) tier = -1;
        if (tier >= 0) (st.bounds ||= []).push({ pos: st.buf.replace(/\s+$/, '').length + 1, tier });
      }
      st.boundaryTier = 0;
      append(s);
    } else {
      if (!st.book || !st.chapter || st.verse < 1) return;
      st.buf += s;
    }
  }
}

/** Textstücke zu einer Zeichenkette verbinden – Leerzeichen nur bei echtem Abstand */
function joinText(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  let out = '';
  let prev = null;
  for (const i of sorted) {
    if (prev) {
      const sameLine = Math.abs(prev.y - i.y) < i.size * 0.5;
      const gap = i.x - (prev.x + prev.w);
      if (!sameLine || gap > i.size * 0.15) out += ' ';
    }
    out += i.s;
    prev = i;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function guessName(meta, fileName) {
  const t = `${meta.Title || ''} ${fileName}`.toLowerCase();
  if (t.includes('schlachter')) return 'Schlachter 2000';
  if (meta.Title && meta.Title.trim().length > 2) return meta.Title.trim();
  return fileName.replace(/\.pdf$/i, '');
}

// Chapter counts that differ between traditions (Joel 3/4, Maleachi 3/4)
const FLEX = { 29: [3, 4], 39: [3, 4] };

function buildReport(books) {
  const missingBooks = [];
  const chapterIssues = [];
  let verses = 0;
  let chapters = 0;
  let emptyVerses = 0;
  books.forEach((b, i) => {
    const id = i + 1;
    if (!b) return missingBooks.push(BOOKS[i].name);
    chapters += b.filter((c) => c && c.length).length;
    const expected = FLEX[id] || [BOOKS[i].chapters];
    const got = b.length;
    const emptyCh = b.map((c, ci) => (!c || !c.length ? ci + 1 : 0)).filter(Boolean);
    if (!expected.includes(got) || emptyCh.length) {
      chapterIssues.push(`${BOOKS[i].name}: ${got} von ${expected[expected.length - 1]} Kapiteln${emptyCh.length ? ` (fehlend: ${emptyCh.slice(0, 6).join(', ')}${emptyCh.length > 6 ? ' …' : ''})` : ''}`);
    }
    for (const c of b) for (const v of c || []) { if (v) verses++; else emptyVerses++; }
  });
  return { books: 66 - missingBooks.length, missingBooks, chapters, verses, emptyVerses, chapterIssues };
}
