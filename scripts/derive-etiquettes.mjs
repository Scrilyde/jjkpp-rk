#!/usr/bin/env node
// Dérive data/etiquettes.json : règles « mot-clé du texte anglais du wiki → étiquette », apprises sur les fiches
// existantes rapprochées du wiki, avec précision et rappel mesurés en leave-one-out. Sert aux nouvelles fiches de la synchro.
// Usage : node scripts/derive-etiquettes.mjs [--data <characters.json>] [--out <etiquettes.json>] [--cache <dossier>] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, loadWiki, cleanWikitext, isBlank } from './lib/wiki.mjs';
import { matchFiches, wikiKit, titleFromUrl } from './lib/fiches.mjs';
import { kitWords, ngrams, deduceTags } from './lib/etiquettes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_SUPPORT = 3;          // un mot-clé doit être vu dans au moins 3 fiches portant l'étiquette
const MIN_RULE_PRECISION = 0.9; // et désigner l'étiquette dans au moins 90 % des fiches où il apparaît
const MAX_RULES = 6;            // par étiquette
const MIN_TAG_PRECISION = 0.8;  // étiquette exclue si sa précision leave-one-out est inférieure

export function deriveRules(samples) {
  const tags = [...new Set(samples.flatMap(s => s.tags))].sort((a, b) => a.localeCompare(b, 'fr'));
  const withKeyword = new Map();   // mot-clé → indices des fiches qui le contiennent
  samples.forEach((s, i) => s.grams.forEach(g => (withKeyword.get(g) || withKeyword.set(g, []).get(g)).push(i)));
  const rules = [];
  for (const tag of tags) {
    const positives = new Set(samples.map((s, i) => (s.tags.includes(tag) ? i : -1)).filter(i => i >= 0));
    if (positives.size < MIN_SUPPORT) continue;
    const candidates = [];
    for (const [k, idx] of withKeyword) {
      if (idx.length < MIN_SUPPORT) continue;
      const tp = idx.filter(i => positives.has(i));
      if (tp.length >= MIN_SUPPORT && tp.length / idx.length >= MIN_RULE_PRECISION) candidates.push({ k, tp: new Set(tp), precision: tp.length / idx.length, support: idx.length });
    }
    // couverture gloutonne : chaque règle retenue doit apporter des fiches positives encore non couvertes
    candidates.sort((a, b) => b.precision - a.precision || b.tp.size - a.tp.size || a.k.split(' ').length - b.k.split(' ').length || (a.k < b.k ? -1 : 1));
    const covered = new Set();
    for (const c of candidates) {
      if (rules.filter(r => r['étiquette'] === tag).length >= MAX_RULES) break;
      if ([...c.tp].every(i => covered.has(i))) continue;
      c.tp.forEach(i => covered.add(i));
      rules.push({ 'mot_clé': c.k, 'étiquette': tag, 'précision': Math.round(c.precision * 100) / 100, 'fiches': c.support });
    }
  }
  return rules;
}

export function evaluate(samples) {
  const perTag = new Map(), get = t => perTag.get(t) || perTag.set(t, { tp: 0, fp: 0, fn: 0 }).get(t);
  samples.forEach((target, i) => {
    const rules = deriveRules(samples.filter((_, j) => j !== i));
    const predicted = new Set(deduceTags(target.words, { 'règles': rules }).keys());
    for (const t of predicted) target.tags.includes(t) ? get(t).tp++ : get(t).fp++;
    for (const t of target.tags) if (!predicted.has(t)) get(t).fn++;
  });
  return perTag;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const dataPath = path.resolve(opt('--data') || path.join(ROOT, 'data', 'characters.json'));
  const outPath = path.resolve(opt('--out') || path.join(ROOT, 'data', 'etiquettes.json'));
  const fiches = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const client = createClient({ cacheDir: opt('--cache'), log: console.log });
  const wiki = await loadWiki(client, [...fiches.map(f => f['page_wiki']), ...fiches.map(f => titleFromUrl(f['url_wiki']))].filter(Boolean));
  const samples = matchFiches(fiches, wiki).filter(r => r.title && r.exists && (r.fiche['étiquettes'] || []).length).map(r => {
    const w = wiki.wikiParams[r.title];
    const words = kitWords(wikiKit(w).kit, isBlank(w['Characteristic']) ? '' : cleanWikitext(w['Characteristic']));
    return { titre: r.fiche['titre'], tags: r.fiche['étiquettes'], words, grams: ngrams(words) };
  });
  console.log(`${samples.length} fiches étiquetées rapprochées du wiki — ${client.calls} appels API`);

  // Évaluation leave-one-out, puis exclusion des étiquettes trop peu précises.
  const perTag = evaluate(samples);
  const pct = (a, b) => (b ? `${Math.round(100 * a / b)} %` : '—');
  const excluded = new Set([...perTag].filter(([, s]) => s.tp + s.fp > 0 && s.tp / (s.tp + s.fp) < MIN_TAG_PRECISION).map(([t]) => t));
  let tp = 0, fp = 0, fn = 0;
  const parTag = {};
  for (const [t, s] of [...perTag].sort((a, b) => a[0].localeCompare(b[0], 'fr'))) {
    parTag[t] = { 'précision': s.tp + s.fp ? Math.round(100 * s.tp / (s.tp + s.fp)) / 100 : null, 'rappel': s.tp + s.fn ? Math.round(100 * s.tp / (s.tp + s.fn)) / 100 : null, 'exclue': excluded.has(t) };
    if (!excluded.has(t)) { tp += s.tp; fp += s.fp; } fn += s.fn;
    console.log(`  ${t.padEnd(42)} précision ${pct(s.tp, s.tp + s.fp).padStart(5)}  rappel ${pct(s.tp, s.tp + s.fn).padStart(5)}  (${s.tp} justes, ${s.fp} en trop, ${s.fn} manquées)${excluded.has(t) ? '  → exclue' : ''}`);
  }
  console.log(`Leave-one-out, étiquettes retenues : précision ${pct(tp, tp + fp)} (${tp}/${tp + fp}), rappel ${pct(tp, tp + fn)} (${tp}/${tp + fn})`);

  const rules = deriveRules(samples).filter(r => !excluded.has(r['étiquette']));
  console.log(`${rules.length} règles retenues pour ${new Set(rules.map(r => r['étiquette'])).size} étiquettes`);
  if (process.env.ETIQUETTES_REGLES) rules.forEach(r => console.log(`  « ${r['mot_clé']} » → ${r['étiquette']} (${r['précision']}, ${r['fiches']} fiches)`));
  const previous = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const table = {
    '_à_propos': 'Généré par scripts/derive-etiquettes.mjs. Règles « mot-clé du texte anglais du wiki → étiquette » apprises sur les fiches existantes ; appliquées par la synchro aux nouvelles fiches seulement (étiquettes marquées dans « étiquettes_automatiques »). « règles_manuelles » n\'est jamais écrasé et prime : { "mot-clé": "Étiquette" } ajoute une règle, { "mot-clé": null } en désactive une.',
    'évaluation_leave_one_out': { 'fiches': samples.length, 'précision': tp + fp ? Math.round(100 * tp / (tp + fp)) / 100 : null, 'rappel': tp + fn ? Math.round(100 * tp / (tp + fn)) / 100 : null, 'par_étiquette': parTag },
    'règles': rules,
    'règles_manuelles': previous['règles_manuelles'] || {},
  };
  if (args.includes('--dry-run')) { console.log('--dry-run : rien n\'a été écrit.'); return; }
  fs.writeFileSync(outPath, JSON.stringify(table, null, 2) + '\n');
  console.log(`Écrit : ${outPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
