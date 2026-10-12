// Traduction EN → FR ligne par ligne à partir de data/glossaire.json.
// Ordre : surcharge manuelle > motif de ligne dérivé > composition par fragments > cache DeepL > anglais.

const EN_NUMBER = /\d+(?:\.\d+)?/g;
const FR_NUMBER = /\d+(?:,\d+)?/g;

// Espaces et casse du wiki sont irréguliers (« ranged »/« Ranged », « enemies(4 Hits) ») : clé de recherche normalisée.
const normalize = line => line.trim().replace(/\s+/g, ' ').replace(/(\w)\(/g, '$1 (');
export const lookupKey = key => key.toLowerCase();

// « Deals 100.0% … (3 Hits) » → { key: « Deals {0}% … ({1} Hits) », nums: ['100.0', '3'] }
export function abstractLine(line) {
  const nums = [];
  const key = normalize(line).replace(EN_NUMBER, n => `{${nums.push(n) - 1}}`);
  return { key, nums };
}

// Le FR existant est souvent plus précis que le wiki (74,67 contre 74.7) : égalité à l'arrondi du nombre EN.
export function sameNumber(en, frValue) {
  const decimals = (String(en).split('.')[1] || '').length;
  return Math.abs(Number(frValue.toFixed(decimals)) - Number(en)) < 1e-9;
}

// Associe chaque nombre FR à un nombre EN distinct (égalité exacte d'abord, puis à l'arrondi) ; null si impossible.
export function matchNumbers(enNums, frNums) {
  if (enNums.length !== frNums.length) return null;
  const used = new Array(enNums.length).fill(false);
  const map = [];
  for (const f of frNums) {
    let i = enNums.findIndex((e, j) => !used[j] && Number(e) === f);
    if (i < 0) i = enNums.findIndex((e, j) => !used[j] && sameNumber(e, f));
    if (i < 0) return null;
    used[i] = true; map.push(i);
  }
  return map;
}

const frNumbers = fr => (fr.match(FR_NUMBER) || []).map(n => Number(n.replace(',', '.')));

// Remplace les nombres d'un segment FR par les marqueurs {i} des nombres EN correspondants ; null si impossible.
export function frTemplate(fr, enNums) {
  const map = matchNumbers(enNums, frNumbers(fr));
  if (!map) return null;
  let k = 0;
  return fr.replace(FR_NUMBER, () => `{${map[k++]}}`);
}

// Nombres au format français, espace insécable avant « % ».
const fillNumbers = (tpl, nums) => tpl.replace(/\{(\d+)\}/g, (_, i) => nums[Number(i)].replace('.', ',')).replace(/(\d) ?%/g, '$1 %');

// ---- Fragments -------------------------------------------------------------------------------

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = /[\p{L}\p{N}]/u;

// Découpe une clé EN en texte littéral et fragments du vocabulaire (correspondance la plus longue, sans casse).
export function tokenizer(vocabulaire) {
  const entries = Object.entries(vocabulaire || {}).flatMap(([cls, values]) => values.map(v => ({ cls, v })));
  if (!entries.length) return () => [{ text: '' }];
  entries.sort((a, b) => b.v.length - a.v.length);
  const byValue = new Map(entries.map(e => [e.v.toLowerCase(), e.cls]));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${entries.map(e => escapeRe(e.v)).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return key => {
    const out = []; let last = 0;
    for (const m of key.matchAll(re)) {
      if (m.index > last) out.push({ text: key.slice(last, m.index) });
      out.push({ cls: byValue.get(m[0].toLowerCase()), value: m[0].toLowerCase(), raw: m[0] });
      last = m.index + m[0].length;
    }
    if (last < key.length) out.push({ text: key.slice(last) });
    return out;
  };
}

// Clé de cadre : les fragments de `mask` (indices parmi les fragments) deviennent {CLASSE#n}.
export function frameKey(tokens, mask) {
  const count = {}; let slotIndex = -1;
  const slots = [];
  const key = tokens.map(t => {
    if (t.text != null) return t.text;
    slotIndex++;
    if (!mask.includes(slotIndex)) return t.raw;
    count[t.cls] = (count[t.cls] || 0) + 1;
    const name = `${t.cls}#${count[t.cls]}`;
    slots.push({ name, cls: t.cls, value: t.value });
    return `{${name}}`;
  }).join('');
  return { key, slots };
}

// Sous-ensembles non vides des indices 0..n-1, du plus petit au plus grand.
export function subsets(n, max = 6) {
  if (n > max) return [];
  const out = [];
  for (let bits = 1; bits < 1 << n; bits++) out.push([...Array(n).keys()].filter(i => bits & (1 << i)));
  return out.sort((a, b) => a.length - b.length);
}

// Occurrence unique d'un fragment FR en tant que mot(s) entier(s) ; -1 si absente ou multiple.
export function uniqueWordIndex(text, part) {
  let found = -1, from = 0;
  for (;;) {
    const i = text.indexOf(part, from);
    if (i < 0) return found;
    const before = text[i - 1], after = text[i + part.length];
    if (!(before && WORD.test(before)) && !(after && WORD.test(after))) { if (found >= 0) return -1; found = i; }
    from = i + 1;
  }
}

// ---- Traducteur ------------------------------------------------------------------------------

const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

export function createTranslator(glossaire, { deepl = {} } = {}) {
  const manual = new Map(Object.entries(glossaire['lignes_manuelles'] || {}).map(([k, v]) => [lookupKey(k), v]));
  const lines = new Map(Object.entries(glossaire['lignes'] || {}).map(([k, v]) => [lookupKey(k), v]));
  const deeplLines = new Map(Object.entries(deepl).map(([k, v]) => [lookupKey(k), v]));
  const names = { ...(glossaire['noms'] || {}), ...(glossaire['noms_manuels'] || {}) };
  const frag = glossaire['fragments'] || {};
  const tokenize = tokenizer(frag['vocabulaire']);
  const frames = new Map(Object.entries(frag['cadres'] || {}).map(([k, v]) => [lookupKey(k), v]));
  const filler = (cls, value) => {
    const m = glossaire['fragments_manuels']?.[cls];
    if (own(m, value)) return m[value];
    return frag['valeurs']?.[cls]?.[value] ?? null;
  };
  const pending = new Map();   // clés restées en anglais → graphie d'origine (pour DeepL)

  function compose(key) {
    const tokens = tokenize(key);
    const n = tokens.filter(t => t.cls).length;
    let best = null;
    for (const mask of subsets(n)) {
      if (best && mask.length > best.size) break;
      const { key: fk, slots } = frameKey(tokens, mask);
      const frame = frames.get(lookupKey(fk));
      if (!frame) continue;
      // Une valeur nouvelle n'entre dans un cadre que si elle a déjà été vue interchangeable (même cadre FR, ailleurs)
      // avec une valeur observée dans ce cadre : les deux équivalents FR ont alors la même granularité.
      const parts = slots.map(s => ({ ...s, fr: filler(s.cls, s.value) }));
      const allowed = parts.every(p => {
        const seen = frame['valeurs_vues'][p.name] || [];
        const compatible = frag['compatibles']?.[p.cls]?.[p.value] || [];
        return p.fr != null && (seen.includes(p.value) || seen.some(v => compatible.includes(v)));
      });
      if (!allowed) continue;
      if (!best || frame['fiches'] > best.fiches) best = { size: mask.length, fiches: frame['fiches'], frame: fk, fr: parts.reduce((s, p) => s.split(`{${p.name}}`).join(p.fr), frame['fr']) };
    }
    return best;
  }

  function line(en) {
    if (en.trim() === '') return { fr: en, source: null };
    const { key, nums } = abstractLine(en);
    const lk = lookupKey(key);
    if (manual.has(lk)) return manual.get(lk) == null ? { fr: en, source: 'anglais' } : { fr: fillNumbers(manual.get(lk), nums), source: 'manuel' };
    if (lines.has(lk)) return { fr: fillNumbers(lines.get(lk), nums), source: 'glossaire' };
    const c = compose(key);
    if (c) return { fr: fillNumbers(c.fr, nums), source: 'composée', cadre: c.frame };
    if (deeplLines.has(lk)) return { fr: fillNumbers(deeplLines.get(lk), nums), source: 'deepl' };
    pending.set(lk, key);
    return { fr: en, source: 'anglais' };
  }

  return {
    pending,
    // Texte multiligne → { text, lines: [{ n, en, fr, source, cadre }] } ; chaque ligne est traduite indépendamment.
    translate(en) {
      if (en == null || en === '') return { text: en, lines: [] };
      const details = en.split('\n').map((l, i) => ({ n: i + 1, en: l, ...line(l) }));
      return { text: details.map(d => d.fr).join('\n'), lines: details.filter(d => d.source) };
    },
    text(en) { return this.translate(en).text; },
    name: en => (en && names[en]) || en,
    // Valeur d'une table (élément, rôle…) ; null si inconnue ou volontairement laissée en anglais.
    value(table, en) {
      const m = glossaire['valeurs_manuelles']?.[table];
      if (own(m, en)) return m[en];
      return own(glossaire['valeurs']?.[table], en) ? glossaire['valeurs'][table][en] : null;
    },
  };
}
