// Übersetzungen: eingebaute (Dateien im Ordner data/) und importierte (IndexedDB)
import { db, uid } from './db.js';
import { BOOKS, findBook } from './books.js';

export const BUILTIN = [
  {
    id: 'elb1905',
    name: 'Elberfelder 1905',
    short: 'ELB 1905',
    builtin: true,
    path: 'data/bibles/elb1905/',
    note: 'Gemeinfrei · unrevidierte Elberfelder',
  },
];

let imported = []; // [{id, name, short, books}]
const bookCache = new Map(); // "transId:bookId" -> chapters[][]

export async function loadImported() {
  try {
    imported = await db.all('bibles');
  } catch (e) {
    console.warn('Importierte Übersetzungen konnten nicht geladen werden', e);
    imported = [];
  }
  return imported;
}

export function listTranslations() {
  return [
    ...BUILTIN,
    ...imported.map((t) => ({ id: t.id, name: t.name, short: t.short, builtin: false, note: t.note || 'Importiert' })),
  ];
}

export function getTranslation(id) {
  return listTranslations().find((t) => t.id === id) || BUILTIN[0];
}

/** Liefert alle Kapitel eines Buches: string[][] (Kapitel -> Verse) oder null */
export async function getBookData(transId, bookId) {
  const key = `${transId}:${bookId}`;
  if (bookCache.has(key)) return bookCache.get(key);
  const builtin = BUILTIN.find((t) => t.id === transId);
  let data = null;
  if (builtin) {
    const res = await fetch(`${builtin.path}${String(bookId).padStart(2, '0')}.json`);
    if (res.ok) data = await res.json();
  } else {
    const t = imported.find((x) => x.id === transId);
    data = t?.books?.[bookId - 1] || null;
  }
  bookCache.set(key, data);
  return data;
}

export async function getChapter(transId, bookId, chapter) {
  const book = await getBookData(transId, bookId);
  return book?.[chapter - 1] || null;
}

export async function deleteImported(id) {
  await db.del('bibles', id);
  imported = imported.filter((t) => t.id !== id);
  for (const k of [...bookCache.keys()]) if (k.startsWith(id + ':')) bookCache.delete(k);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Importiert eine Datei (Zefania-XML oder JSON) und speichert sie lokal.
 * @returns {Promise<{id, name, verses:number}>}
 */
export async function importBibleFile(file) {
  const text = await file.text();
  const trimmed = text.trimStart();
  let parsed;
  if (trimmed.startsWith('<')) parsed = parseXml(text);
  else parsed = parseJson(JSON.parse(text));

  if (!parsed || !parsed.books.some(Boolean)) {
    throw new Error('In der Datei wurden keine Bibelverse gefunden.');
  }
  const fallbackName = file.name.replace(/\.(xml|json)$/i, '');
  const name = (parsed.name || fallbackName).trim();
  const entry = {
    id: uid('bib_'),
    name,
    short: makeShort(name),
    note: `Importiert aus ${file.name}`,
    books: parsed.books,
  };
  await db.put('bibles', entry);
  imported.push(entry);
  let verses = 0;
  for (const b of parsed.books) if (b) for (const c of b) if (c) verses += c.filter(Boolean).length;
  return { id: entry.id, name, verses };
}

function makeShort(name) {
  const m = name.match(/schlachter\s*(\d{4})/i);
  if (m) return `SCH ${m[1]}`;
  return name.length > 14 ? name.slice(0, 13) + '…' : name;
}

/** Fügt einen Vers an die richtige Stelle ein */
function put(books, bookId, ch, v, text) {
  if (!bookId || bookId < 1 || bookId > 66 || !ch || !v) return;
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  const b = (books[bookId - 1] ||= []);
  const c = (b[ch - 1] ||= []);
  c[v - 1] = c[v - 1] ? c[v - 1] + ' ' + t : t;
}

/** Lücken (leere Kapitel / Verse) mit Platzhaltern füllen */
function finalize(books) {
  for (let i = 0; i < 66; i++) {
    const b = books[i];
    if (!b) { books[i] = null; continue; }
    for (let c = 0; c < b.length; c++) {
      b[c] = b[c] || [];
      for (let v = 0; v < b[c].length; v++) if (b[c][v] == null) b[c][v] = '';
    }
  }
  books.length = 66;
  return books;
}

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Die XML-Datei ist fehlerhaft.');
  const root = doc.documentElement;
  const books = [];

  // --- Zefania XML: <XMLBIBLE><BIBLEBOOK bnumber><CHAPTER cnumber><VERS vnumber>
  const zBooks = root.getElementsByTagName('BIBLEBOOK');
  if (zBooks.length) {
    const name =
      root.getAttribute('biblename') ||
      root.querySelector('INFORMATION > title, INFORMATION > TITLE')?.textContent ||
      '';
    for (const bk of zBooks) {
      let id = parseInt(bk.getAttribute('bnumber'), 10);
      if (!(id >= 1 && id <= 66)) {
        const b = findBook(bk.getAttribute('bname') || bk.getAttribute('bsname') || '');
        id = b?.id;
      }
      if (!id || id > 66) continue; // Apokryphen werden übersprungen
      for (const ch of bk.getElementsByTagName('CHAPTER')) {
        const c = parseInt(ch.getAttribute('cnumber'), 10);
        for (const vs of ch.getElementsByTagName('VERS')) {
          put(books, id, c, parseInt(vs.getAttribute('vnumber'), 10), cleanNode(vs));
        }
      }
    }
    return { name, books: finalize(books) };
  }

  // --- OSIS XML: <verse osisID="Gen.1.1">text</verse>
  const verses = root.getElementsByTagName('verse');
  if (verses.length) {
    const name = root.querySelector('work > title')?.textContent || '';
    const osisRef = (id) => {
      const [bk, c, n] = (id || '').split(' ')[0].split('.');
      const bid = OSIS_IDS.indexOf(bk) + 1;
      return bid > 0 ? [bid, +c, +n] : null;
    };
    const milestone = [...verses].some((v) => v.getAttribute('sID'));
    if (!milestone) {
      // Container-Verse: <verse osisID="Gen.1.1">Text</verse>
      for (const v of verses) {
        const r = osisRef(v.getAttribute('osisID'));
        if (r) put(books, r[0], r[1], r[2], cleanNode(v));
      }
    } else {
      // Milestone-Verse: <verse sID osisID/> Text <verse eID/>
      let current = null;
      let buf = '';
      const flush = () => {
        if (current) put(books, current[0], current[1], current[2], buf);
        current = null;
        buf = '';
      };
      const skipped = (node) => {
        for (let p = node.parentNode; p && p !== root; p = p.parentNode) {
          if (/^(note|title)$/i.test(p.tagName)) return true;
        }
        return false;
      };
      const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeType === 1 && n.tagName === 'verse') {
          if (n.getAttribute('sID')) {
            flush();
            current = osisRef(n.getAttribute('osisID'));
          } else if (n.getAttribute('eID')) flush();
        } else if (n.nodeType === 3 && current && !skipped(n)) {
          buf += n.nodeValue;
        }
      }
      flush();
    }
    return { name, books: finalize(books) };
  }

  throw new Error('Unbekanntes XML-Format. Unterstützt: Zefania-XML und OSIS.');
}

function cleanNode(el) {
  const clone = el.cloneNode(true);
  // Fußnoten, Querverweise und Strong-Nummern entfernen
  for (const sel of ['NOTE', 'note', 'XREF', 'title']) {
    for (const n of [...clone.getElementsByTagName(sel)]) n.remove();
  }
  for (const n of [...clone.getElementsByTagName('BR')]) n.replaceWith(' ');
  return clone.textContent;
}

function parseJson(data) {
  const books = [];
  let name = '';

  // Unser eigenes Format: { name, books: [ [ ["Vers1", ...], ... ], ... ] }
  if (data && Array.isArray(data.books) && Array.isArray(data.books[0]) ) {
    name = data.name || '';
    data.books.forEach((b, i) => b && b.forEach((c, ci) => c && c.forEach((v, vi) => put(books, i + 1, ci + 1, vi + 1, v))));
    return { name, books: finalize(books) };
  }
  // Kompakt: [ [ ["Vers1", ...] ] ]
  if (Array.isArray(data) && Array.isArray(data[0]) && Array.isArray(data[0][0])) {
    data.forEach((b, i) => b && b.forEach((c, ci) => c && c.forEach((v, vi) => put(books, i + 1, ci + 1, vi + 1, v))));
    return { name, books: finalize(books) };
  }
  // scrollmapper-Format: { translation, books: [{ name, chapters: [{ chapter, verses: [{ verse, text }] }] }] }
  if (data && Array.isArray(data.books) && data.books[0]?.chapters) {
    name = data.translation || data.name || '';
    data.books.forEach((b, i) => {
      const id = data.books.length === 66 ? i + 1 : findBook(b.name || '')?.id;
      if (!id) return;
      for (const ch of b.chapters) for (const v of ch.verses) put(books, id, ch.chapter, v.verse, v.text);
    });
    return { name, books: finalize(books) };
  }
  // Flache Liste: [{ book|book_id|book_name, chapter, verse, text }]
  const list = Array.isArray(data) ? data : data?.verses;
  if (Array.isArray(list) && list.length && typeof list[0] === 'object') {
    name = data?.name || data?.metadata?.name || '';
    for (const v of list) {
      let id = Number(v.book_id ?? v.book_nr ?? v.bookId ?? v.book);
      if (!(id >= 1 && id <= 66)) id = findBook(String(v.book_name ?? v.book ?? ''))?.id;
      put(books, id, Number(v.chapter), Number(v.verse), v.text);
    }
    return { name, books: finalize(books) };
  }
  throw new Error('Unbekanntes JSON-Format.');
}

const OSIS_IDS = ['Gen', 'Exod', 'Lev', 'Num', 'Deut', 'Josh', 'Judg', 'Ruth', '1Sam', '2Sam', '1Kgs', '2Kgs', '1Chr', '2Chr', 'Ezra', 'Neh', 'Esth', 'Job', 'Ps', 'Prov', 'Eccl', 'Song', 'Isa', 'Jer', 'Lam', 'Ezek', 'Dan', 'Hos', 'Joel', 'Amos', 'Obad', 'Jonah', 'Mic', 'Nah', 'Hab', 'Zeph', 'Hag', 'Zech', 'Mal', 'Matt', 'Mark', 'Luke', 'John', 'Acts', 'Rom', '1Cor', '2Cor', 'Gal', 'Eph', 'Phil', 'Col', '1Thess', '2Thess', '1Tim', '2Tim', 'Titus', 'Phlm', 'Heb', 'Jas', '1Pet', '2Pet', '1John', '2John', '3John', 'Jude', 'Rev'];

export { BOOKS };
