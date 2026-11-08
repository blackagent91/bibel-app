// Bücher der Bibel (Reihenfolge nach Protestantischem Kanon, 1–66)
// [Name, Abkürzung, Kapitelanzahl, weitere Aliase]
const RAW = [
  ['1. Mose', '1Mo', 50, ['genesis', 'gen', '1mose', '1mos']],
  ['2. Mose', '2Mo', 40, ['exodus', 'ex', '2mose', '2mos']],
  ['3. Mose', '3Mo', 27, ['levitikus', 'lev', '3mose', '3mos']],
  ['4. Mose', '4Mo', 36, ['numeri', 'num', '4mose', '4mos']],
  ['5. Mose', '5Mo', 34, ['deuteronomium', 'dtn', '5mose', '5mos']],
  ['Josua', 'Jos', 24, []],
  ['Richter', 'Ri', 21, ['ri']],
  ['Ruth', 'Rt', 4, ['rut', 'ruth']],
  ['1. Samuel', '1Sam', 31, ['1sa']],
  ['2. Samuel', '2Sam', 24, ['2sa']],
  ['1. Könige', '1Kön', 22, ['1kö', '1koe', '1kon', '1kg', '1koenige']],
  ['2. Könige', '2Kön', 25, ['2kö', '2koe', '2kon', '2kg', '2koenige']],
  ['1. Chronik', '1Chr', 29, ['1ch']],
  ['2. Chronik', '2Chr', 36, ['2ch']],
  ['Esra', 'Esr', 10, []],
  ['Nehemia', 'Neh', 13, []],
  ['Esther', 'Est', 10, ['ester']],
  ['Hiob', 'Hi', 42, ['ijob', 'job']],
  ['Psalmen', 'Ps', 150, ['psalm', 'psalter']],
  ['Sprüche', 'Spr', 31, ['sprueche', 'sprichwörter']],
  ['Prediger', 'Pred', 12, ['kohelet', 'koh', 'pr']],
  ['Hohelied', 'Hl', 8, ['hoheslied', 'hld']],
  ['Jesaja', 'Jes', 66, []],
  ['Jeremia', 'Jer', 52, []],
  ['Klagelieder', 'Kla', 5, ['klgl', 'klag']],
  ['Hesekiel', 'Hes', 48, ['ezechiel', 'ez']],
  ['Daniel', 'Dan', 12, ['da']],
  ['Hosea', 'Hos', 14, []],
  ['Joel', 'Joel', 3, []],
  ['Amos', 'Am', 9, []],
  ['Obadja', 'Obd', 1, ['ob', 'obad']],
  ['Jona', 'Jon', 4, []],
  ['Micha', 'Mi', 7, ['mich']],
  ['Nahum', 'Nah', 3, []],
  ['Habakuk', 'Hab', 3, []],
  ['Zephanja', 'Zeph', 3, ['zef', 'zefanja']],
  ['Haggai', 'Hag', 2, []],
  ['Sacharja', 'Sach', 14, []],
  ['Maleachi', 'Mal', 4, []],
  ['Matthäus', 'Mt', 28, ['mat', 'matth', 'matthaeus']],
  ['Markus', 'Mk', 16, ['mar', 'mark']],
  ['Lukas', 'Lk', 24, ['luk']],
  ['Johannes', 'Joh', 21, []],
  ['Apostelgeschichte', 'Apg', 28, ['apostel']],
  ['Römer', 'Röm', 16, ['roem', 'rom', 'roemer']],
  ['1. Korinther', '1Kor', 16, ['1ko']],
  ['2. Korinther', '2Kor', 13, ['2ko']],
  ['Galater', 'Gal', 6, []],
  ['Epheser', 'Eph', 6, []],
  ['Philipper', 'Phil', 4, ['php']],
  ['Kolosser', 'Kol', 4, []],
  ['1. Thessalonicher', '1Thes', 5, ['1th', '1thess']],
  ['2. Thessalonicher', '2Thes', 3, ['2th', '2thess']],
  ['1. Timotheus', '1Tim', 6, ['1ti']],
  ['2. Timotheus', '2Tim', 4, ['2ti']],
  ['Titus', 'Tit', 3, []],
  ['Philemon', 'Phlm', 1, ['phm', 'philem']],
  ['Hebräer', 'Hebr', 13, ['heb', 'hebraeer']],
  ['Jakobus', 'Jak', 5, []],
  ['1. Petrus', '1Petr', 5, ['1pe', '1pt']],
  ['2. Petrus', '2Petr', 3, ['2pe', '2pt']],
  ['1. Johannes', '1Joh', 5, ['1jo']],
  ['2. Johannes', '2Joh', 1, ['2jo']],
  ['3. Johannes', '3Joh', 1, ['3jo']],
  ['Judas', 'Jud', 1, []],
  ['Offenbarung', 'Offb', 22, ['off', 'offenb', 'apk', 'apokalypse', 'offenbarungjohannes', 'offenbarungdesjohannes', 'offenbarungjesuchristi']],
];

export const BOOKS = RAW.map(([name, abbr, chapters, aliases], i) => ({
  id: i + 1,
  name,
  abbr,
  chapters,
  testament: i < 39 ? 'AT' : 'NT',
  aliases,
}));

export function getBook(id) {
  return BOOKS[id - 1];
}

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\./g, '')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');

// Lookup-Tabelle: normalisierter Schlüssel -> Buch-ID
const KEYS = [];
for (const b of BOOKS) {
  const keys = new Set([norm(b.name), norm(b.abbr), ...b.aliases.map(norm)]);
  for (const k of keys) KEYS.push([k, b.id]);
}
// längere Schlüssel zuerst, damit "1joh" vor "1jo" greift
KEYS.sort((a, b) => b[0].length - a[0].length);

export function findBook(query) {
  const q = norm(query);
  if (!q) return null;
  // exakter Treffer
  for (const [k, id] of KEYS) if (k === q) return getBook(id);
  // Präfix-Treffer ("1mo" -> 1. Mose, "offenb" -> Offenbarung)
  for (const b of BOOKS) if (norm(b.name).startsWith(q)) return b;
  for (const [k, id] of KEYS) if (k.startsWith(q)) return getBook(id);
  return null;
}

/**
 * Parst Eingaben wie "1Mo 5", "1. Mose 5,3", "Joh 3,16-18", "Ps 23", "röm8:28"
 * @returns {{book:number, chapter:number, vs?:number, ve?:number} | null}
 */
export function parseRef(input) {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(/^(\d?\s*\.?\s*[^\d\s][^\d]*?)\s*(\d+)?\s*(?:[,:]\s*(\d+)(?:\s*[-–]\s*(\d+))?)?\s*$/);
  if (!m) return null;
  const book = findBook(m[1]);
  if (!book) return null;
  const chapter = Math.min(Math.max(parseInt(m[2] || '1', 10), 1), 150); // genaue Grenze prüft die Bibelansicht
  const res = { book: book.id, chapter };
  if (m[3]) {
    res.vs = parseInt(m[3], 10);
    res.ve = m[4] ? Math.max(parseInt(m[4], 10), res.vs) : res.vs;
  }
  return res;
}

export function formatRef(r, short = false) {
  const b = getBook(r.book);
  if (!b) return '';
  let s = `${short ? b.abbr : b.name} ${r.chapter}`;
  if (r.vs) {
    s += `,${r.vs}`;
    if (r.ve && r.ve !== r.vs) s += `-${r.ve}`;
  }
  return s;
}

/** Vergleich in Bibelreihenfolge */
export function compareRefs(a, b) {
  return a.book - b.book || a.chapter - b.chapter || (a.vs || 0) - (b.vs || 0);
}
