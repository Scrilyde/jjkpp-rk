// Point d'extension optionnel : traduction DeepL des lignes restées en anglais.
// Actif seulement si DEEPL_API_KEY est défini (.env en local, secret GitHub en CI). Les traductions obtenues
// sont gardées dans un cache versionné (data/traductions-deepl.json) : une ligne n'est jamais retraduite.
import fs from 'node:fs';

export const DEEPL_URL = 'https://api-free.deepl.com/v2/translate';

// Charge un fichier .env simple (CLÉ=valeur) sans écraser les variables déjà définies.
export function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// Cache : « lignes » (motifs de ligne) et « noms » (compétences, épithètes).
export function readCache(file) {
  const c = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  return { lignes: c['lignes'] || {}, noms: c['noms'] || {} };
}

export function writeCache(file, { lignes, noms }) {
  const sorted = o => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, JSON.stringify({
    '_à_propos': 'Cache des traductions DeepL (scripts/sync-wiki.mjs). « lignes » — clé : ligne anglaise dont les nombres sont remplacés par {0}, {1}… ; valeur : traduction FR avec les mêmes marqueurs. « noms » : noms de compétences et épithètes. Une entrée présente ici n\'est jamais retraduite ; corriger une valeur à la main est sans risque (une ligne générique a plutôt sa place dans « lignes_manuelles » de data/glossaire.json).',
    'lignes': sorted(lignes),
    'noms': sorted(noms),
  }, null, 2) + '\n');
}

const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Contexte transmis à DeepL (non traduit) : lève les ambiguïtés du vocabulaire de jeu.
export const CONTEXT = 'Skill effect descriptions from the turn-based mobile RPG "Jujutsu Kaisen Phantom Parade". Each text is a single line of a skill description. Taijutsu and Jujutsu are stats, Break is a gauge, Counts are stacks of a state.';

// Termes connus (noms de compétences, vocabulaire du jeu) remplacés par leur équivalent FR dans une balise ignorée :
// DeepL ne les retraduit pas, la traduction reste cohérente avec le reste du site.
export function termProtector(terms = {}) {
  const entries = Object.entries(terms).filter(([en, fr]) => en && fr).sort(([a], [b]) => b.length - a.length);
  if (!entries.length) return s => s;
  const byKey = new Map(entries.map(([en, fr]) => [xmlEscape(en).toLowerCase(), fr]));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${entries.map(([en]) => escapeRe(xmlEscape(en))).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return s => s.replace(re, m => `<t>${xmlEscape(byKey.get(m.toLowerCase()))}</t>`);
}

// Corrections [motif, remplacement] appliquées à chaque traduction obtenue (glossaire.json, « corrections_deepl »).
export function corrector(corrections = []) {
  const rules = corrections.map(([motif, remplacement]) => [new RegExp(motif, 'gu'), remplacement]);
  return s => rules.reduce((acc, [re, r]) => acc.replace(re, r), s).replace(/ {2,}/g, ' ').trim();
}

// Traduit des clés (« Deals {0}% … ») ; les marqueurs {i} sont protégés par des balises XML ignorées par DeepL.
// Ne lève jamais : en cas d'erreur, renvoie ce qui a été obtenu et la raison.
export async function translateKeys(keys, { apiKey, url = DEEPL_URL, terms = {}, corrections = [], batch = 50, pauseMs = 1000, log = () => {} }) {
  const out = {};
  const protect = termProtector(terms), correct = corrector(corrections);
  for (let i = 0; i < keys.length; i += batch) {
    const chunk = keys.slice(i, i + batch);
    const text = chunk.map(k => protect(xmlEscape(k)).replace(/\{(\d+)\}/g, '<x i="$1"/>'));
    try {
      if (i) await new Promise(r => setTimeout(r, pauseMs));
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source_lang: 'EN', target_lang: 'FR', context: CONTEXT, tag_handling: 'xml', ignore_tags: ['x', 't'] }),
      });
      if (!res.ok) return { translations: out, error: `DeepL a répondu ${res.status} ${res.statusText}` };
      const body = await res.json();
      body.translations.forEach((t, k) => {
        const fr = correct(xmlUnescape(t.text.replace(/<x i="(\d+)"\s*\/>|<x i="(\d+)"><\/x>/g, (_, a, b) => `{${a ?? b}}`).replace(/<\/?t>/g, '')));
        // marqueurs perdus ou dupliqués : on ne garde pas une traduction qui fausserait les valeurs
        const want = (chunk[k].match(/\{\d+\}/g) || []).sort().join(), got = (fr.match(/\{\d+\}/g) || []).sort().join();
        if (want === got) out[chunk[k]] = fr.replace(/(\})\s?%/g, '$1 %');
        else log(`  DeepL : marqueurs altérés, ligne ignorée : ${chunk[k]}`);
      });
    } catch (error) {
      return { translations: out, error: `DeepL injoignable : ${error.message}` };
    }
  }
  return { translations: out, error: null };
}
