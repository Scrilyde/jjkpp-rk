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

export function readCache(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))['lignes'] || {} : {};
}

export function writeCache(file, lignes) {
  const sorted = Object.fromEntries(Object.entries(lignes).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, JSON.stringify({
    '_à_propos': 'Cache des traductions DeepL (scripts/sync-wiki.mjs). Clé : ligne anglaise dont les nombres sont remplacés par {0}, {1}… ; valeur : traduction FR avec les mêmes marqueurs. Une ligne présente ici n\'est jamais retraduite ; corriger une valeur à la main est sans risque.',
    'lignes': sorted,
  }, null, 2) + '\n');
}

const xmlEscape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnescape = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Traduit des clés (« Deals {0}% … ») ; les marqueurs {i} sont protégés par des balises XML ignorées par DeepL.
// Ne lève jamais : en cas d'erreur, renvoie ce qui a été obtenu et la raison.
export async function translateKeys(keys, { apiKey, url = DEEPL_URL, batch = 50, pauseMs = 1000, log = () => {} }) {
  const out = {};
  for (let i = 0; i < keys.length; i += batch) {
    const chunk = keys.slice(i, i + batch);
    const text = chunk.map(k => xmlEscape(k).replace(/\{(\d+)\}/g, '<x i="$1"/>'));
    try {
      if (i) await new Promise(r => setTimeout(r, pauseMs));
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `DeepL-Auth-Key ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, source_lang: 'EN', target_lang: 'FR', tag_handling: 'xml', ignore_tags: ['x'] }),
      });
      if (!res.ok) return { translations: out, error: `DeepL a répondu ${res.status} ${res.statusText}` };
      const body = await res.json();
      body.translations.forEach((t, k) => {
        const fr = xmlUnescape(t.text.replace(/<x i="(\d+)"\s*\/>|<x i="(\d+)"><\/x>/g, (_, a, b) => `{${a ?? b}}`));
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
