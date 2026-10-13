// Étiquettes automatiques des nouvelles fiches : règles « mot-clé anglais du wiki → étiquette » (data/etiquettes.json).

const MAX_WORDS = 3;
// Mots vides : un mot-clé ne commence ni ne finit par l'un d'eux (évite « by an », « fills own and »…).
const STOP = new Set('a an the of to by and or for with in on at is are be if from own all its it their this that as per each when while after before up than'.split(' '));

// Texte anglais d'un kit (wikiKit) découpé en segments (lignes, propositions) de mots minuscules, nombres neutralisés.
export function kitWords(kit, extra = '') {
  const parts = [extra];
  const add = b => { if (b) for (const k of ['effet', 'modifié_effet', 'effet_renforcé']) if (typeof b[k] === 'string') parts.push(b[k]); };
  add(kit['attaque_normale']); kit['compétences'].forEach(add); add(kit['ultime']); kit['compétences_auto'].forEach(add); add(kit['ultime_coopérative']);
  return parts.join('\n').toLowerCase().replace(/\d+(?:\.\d+)?/g, '#').split(/[\n.,:;()/"«»]+/)
    .map(s => s.match(/[a-z#]+(?:'[a-z]+)?/g) || []).filter(s => s.length);
}

// Suites de 1 à 3 mots d'un même segment (candidates comme mots-clés).
export function ngrams(segments) {
  const out = new Set();
  for (const words of segments) for (let i = 0; i < words.length; i++) for (let n = 1; n <= MAX_WORDS && i + n <= words.length; n++) {
    const g = words.slice(i, i + n);
    if (!STOP.has(g[0]) && !STOP.has(g[g.length - 1]) && !g.includes('#')) out.add(g.join(' '));
  }
  return out;
}

// Étiquettes déduites : Map étiquette → mots-clés trouvés. Les règles manuelles priment ; null y désactive un mot-clé.
export function deduceTags(words, table) {
  const present = ngrams(words);
  const rules = new Map((table['règles'] || []).map(r => [r['mot_clé'], r['étiquette']]));
  for (const [k, v] of Object.entries(table['règles_manuelles'] || {})) { if (v == null) rules.delete(k); else rules.set(k, v); }
  const out = new Map();
  for (const [k, tag] of rules) if (present.has(k)) out.set(tag, [...(out.get(tag) || []), k]);
  return out;
}
