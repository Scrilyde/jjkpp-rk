#!/usr/bin/env node
// Synchronise les souvenirs SSR depuis la liste du wiki, sans supprimer les fiches existantes.
// Usage : node scripts/sync-souvenirs.mjs [--dry-run] [--data fichier] [--cache dossier]
//         [--report fichier.md] [--commit-message fichier]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, fetchWikitext, resolveTitles, fetchImageUrls, WIKI } from './lib/wiki.mjs';
import { MEMORY_LIST, parseMemoryList, buildMemory } from './lib/souvenirs.mjs';
import { createTranslator } from './lib/traduction.mjs';
import { loadDotEnv, readCache, writeCache, translateKeys, DEEPL_URL } from './lib/deepl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const DRY = args.includes('--dry-run');
const DATA = path.resolve(opt('--data', path.join(ROOT, 'data/souvenirs.json')));
const REPORT = path.resolve(opt('--report', path.join(ROOT, 'sync-souvenirs-report.md')));
const MESSAGE = opt('--commit-message', null);
const CACHE = path.join(ROOT, 'data/traductions-deepl.json');

async function main() {
  loadDotEnv(path.join(ROOT, '.env'));
  const original = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const glossaire = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/glossaire.json'), 'utf8'));
  const client = createClient({ cacheDir: opt('--cache', null), log: console.log });
  const lists = await fetchWikitext(client, [MEMORY_LIST]);
  const entries = parseMemoryList(lists[MEMORY_LIST]?.content || '');
  const existingSSR = original.filter(m => m.rareté === 'SSR');
  // Une liste vide ou fortement tronquée ne doit jamais provoquer une mise à jour partielle silencieuse.
  if (entries.length < Math.max(50, existingSSR.length * 0.75)) throw new Error(`Liste SSR Memory incomplète (${entries.length} entrées) : synchronisation annulée.`);
  const resolved = await resolveTitles(client, [...entries.map(e => e.title), ...existingSSR.map(m => m.page_wiki || m.titre)]);
  const canon = title => resolved[title]?.title || title;
  const byTitle = new Map();
  for (const memory of existingSSR) {
    const title = canon(memory.page_wiki || memory.titre);
    if (byTitle.has(title)) throw new Error(`Plusieurs souvenirs correspondent à ${title}`);
    byTitle.set(title, memory);
  }
  const targets = new Map(entries.map(e => [canon(e.title), { title: canon(e.title), icon: e.icon }]));
  const warnings = [];
  for (const [title, memory] of byTitle) {
    if (!targets.has(title)) warnings.push(`${title} : absent de SSR Memory, fiche conservée.`);
  }
  const pages = await fetchWikitext(client, [...targets.keys()]);
  for (const title of targets.keys()) if (!pages[title]) {
    warnings.push(`${title} : page introuvable, fiche existante conservée sans modification.`);
    targets.delete(title);
  }

  // Valider toutes les fiches avant de traduire ou d'écrire ; découvrir les clés d'illustration.
  const identity = { translate: text => ({ text }) };
  const drafts = [];
  for (const entry of targets.values()) {
    try {
      drafts.push(buildMemory({ ...entry, content: pages[entry.title].content, previous: byTitle.get(entry.title) }, identity));
    } catch (error) {
      warnings.push(`${error.message} : fiche ignorée, version existante conservée si disponible.`);
      targets.delete(entry.title);
    }
  }
  if (!drafts.length) throw new Error('Aucune fiche SSR exploitable : synchronisation annulée.');
  const images = await fetchImageUrls(client, [...targets.values()].map(e => e.icon).filter(Boolean));
  let missing = [...new Set(drafts.map(m => m['clé_image']).filter(Boolean))];
  for (const ext of ['gif', 'png', 'jpg', 'jpeg']) {
    if (!missing.length) break;
    const urls = await fetchImageUrls(client, missing.map(key => `${key}.${ext}`));
    for (const key of missing) if (urls[`${key}.${ext}`]) images[key] = urls[`${key}.${ext}`];
    missing = missing.filter(key => !images[key]);
  }
  for (const key of missing) warnings.push(`Illustration introuvable : ${key} (ancienne URL conservée si disponible).`);
  let cache = readCache(CACHE), translations = 0;
  const build = () => {
    const tr = createTranslator(glossaire, { deepl: cache.lignes, deeplNames: cache.noms });
    const memories = [...targets.values()].map(e => buildMemory({ ...e, content: pages[e.title].content, images, previous: byTitle.get(e.title) }, tr));
    return { tr, memories };
  };
  let { tr, memories } = build();
  if (tr.pending.size && process.env.DEEPL_API_KEY) {
    const res = await translateKeys([...tr.pending.values()], {
      apiKey: process.env.DEEPL_API_KEY, url: process.env.DEEPL_API_URL || DEEPL_URL,
      terms: tr.terms(), corrections: glossaire.corrections_deepl || [], log: console.log,
    });
    translations = Object.keys(res.translations).length;
    cache.lignes = { ...cache.lignes, ...res.translations };
    if (res.error) warnings.push(res.error);
    ({ tr, memories } = build());
  }
  if (tr.pending.size) warnings.push(`${tr.pending.size} ligne(s) distincte(s) restent en anglais, à traduire ou relire.`);
  const added = memories.filter(m => !byTitle.has(m.page_wiki));
  const modified = memories.filter(m => byTitle.has(m.page_wiki) && JSON.stringify(m) !== JSON.stringify(byTitle.get(m.page_wiki)));
  const replacements = new Map(memories.filter(m => byTitle.has(m.page_wiki)).map(m => [byTitle.get(m.page_wiki).id, m]));
  const dateKey = m => (m.date_de_sortie || '').split('-').reverse().join('');
  added.sort((a, b) => dateKey(b).localeCompare(dateKey(a)));
  const result = [...added, ...original.map(m => replacements.get(m.id) || m)];
  if (!DRY && (added.length || modified.length)) fs.writeFileSync(DATA, JSON.stringify(result, null, 2) + '\n');
  if (!DRY && translations) writeCache(CACHE, cache);
  const report = [
    '# Synchronisation des souvenirs SSR', '',
    `Source : [SSR Memory](${WIKI}/wiki/SSR_Memory), CC BY-SA 3.0.`, '',
    `${entries.length} entrées ; ${added.length} ajout(s), ${modified.length} modification(s).${DRY ? ' Simulation : données non écrites.' : ''}`,
    '', ...added.map(m => `- Ajout : ${m.page_wiki}`), ...modified.map(m => `- Modification : ${m.page_wiki}`),
    '', '## À vérifier', '', ...(warnings.length ? warnings.map(w => `- ${w}`) : ['Aucun avertissement.']), '',
  ].join('\n');
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + report);
  if (!DRY && MESSAGE && (added.length || modified.length)) {
    const prefix = fs.existsSync(MESSAGE) ? '\n' : 'Synchro wiki : personnages et souvenirs\n';
    fs.appendFileSync(MESSAGE, `${prefix}\nSouvenirs SSR : ${added.length} ajout(s), ${modified.length} modification(s).\n`);
  }
  console.log(`${entries.length} souvenirs SSR lus, ${added.length} ajout(s), ${modified.length} modification(s).`);
}

main().catch(error => {
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, `# Échec de la synchronisation des souvenirs SSR\n\n${error.message}\n`);
  console.error(`Échec de la synchronisation des souvenirs : ${error.message}`);
  process.exitCode = 1;
});
