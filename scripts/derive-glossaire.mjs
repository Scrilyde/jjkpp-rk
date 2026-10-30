#!/usr/bin/env node
// Dérive data/glossaire.json des paires EN (wiki) / FR (fiches existantes) déjà rapprochées.
// Les motifs reprennent le style FR majoritaire du site (« l'ennemi ciblé », « équivalant à … du taijutsu »).
// Usage : node scripts/derive-glossaire.mjs [--data <characters.json>] [--out <glossaire.json>] [--cache <dossier>] [--dry-run] [--sans-evaluation]
// Diagnostics : GLOSSAIRE_MISSING=N (lignes les plus fréquentes restées en anglais), GLOSSAIRE_COMPOSEES=N (exemples
// de lignes composées comparées au FR existant), FRAG_DEBUG=1 (votes des équivalents de fragments).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, loadWiki, cleanWikitext } from './lib/wiki.mjs';
import { matchFiches, textPairs, titleFromUrl } from './lib/fiches.mjs';
import { abstractLine, frTemplate, matchNumbers, lookupKey, createTranslator, tokenizer, frameKey, subsets, uniqueWordIndex } from './lib/traduction.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Deux styles FR coexistent. Style retenu (A) : « Inflige des dégâts … à l'ennemi ciblé équivalant à X % du taijutsu »,
// « Applique une augmentation de X % … ». Style écarté (B) : « Inflige X % de dégâts … à l'ennemi sélectionné », « Augmente son propre … ».
const STYLE_A = /ciblé|équivalant à|Applique une (?:augmentation|baisse|réduction)/;
const STYLE_B = /sélectionn|^Inflige (?:\{\d+\}|\d)|^(?:Augmente|Diminue|Réduit)\b|dégâts reçus/m;
// Élément de liste ou remarque (« · … », « ※ … ») : n'a de sens que sous l'en-tête FR qui l'introduit.
const LIST_ITEM = /^[·※]/;

// Validés avec le mainteneur (pas de majorité fiable dans les paires).
const ROLE = { Attacker: 'Attaquant', Debuffer: 'Affaiblisseur', Defender: 'Défenseur', Support: 'Soutien', Supporter: 'Soutien', Obstructor: 'Entravant', Healer: 'Soigneur', Enhancer: 'Renforceur', Interferer: 'Affaiblisseur' };
const SPECIALITE = { Taijutsu: 'Taijutsu', Jujutsu: 'Jujutsu', Combined: 'Hybride', Mixed: 'Hybride', Balanced: 'Hybride' };
const RAYON_NOIR = { Yes: 'Oui', No: 'Non', 'N/A': 'N/D' };
const LIMITE = { Limited: true, 'Movie-Limited': true, 'Event-Limited': false, Standard: false, 'Free To Play': false };

// Fragments interchangeables côté anglais ; leurs équivalents FR sont appris des données (paires minimales).
const VOCABULAIRE = {
  'STAT': ['Taijutsu', 'Jujutsu'],
  'PORTÉE': ['Melee', 'Ranged'],
  'CIBLE': ['the selected enemy', 'all enemies', 'all allies'],
  'POSSESSEUR': ['own', "the selected enemy's", "all enemies'", "all allies'", "own and Combo Ally's", "own and the Combo Ally's"],
  'CARAC': ['Taijutsu Stat', 'Jujutsu Stat', 'Damage Dealt', 'Damage Received', 'Critical Hit Rate', 'Critical Hit Damage', 'Critical Hit Resistance',
    'Break Damage', 'Break Damage Received', 'Black Flash Rate', 'Taijutsu Damage Received', 'Jujutsu Damage Received'],
  'ÉLÉMENT': ['"行" (Yellow)', '"夜" (Green)', '"影" (Blue)', '"幻" (Red)'],
  'DURÉE': ['Turn', 'Turns'],
};

const enNumbers = s => s.match(/\d+(?:\.\d+)?/g) || [];
const frNumbers = s => (s.match(/\d+(?:,\d+)?/g) || []).map(n => Number(n.replace(',', '.')));
const WORD = /[\p{L}\p{N}]/u;
const isWord = ch => ch != null && WORD.test(ch);

// Aligne les lignes EN sur des segments FR consécutifs (1 à 3 lignes) dont les nombres coïncident.
// Des lignes propres à une langue peuvent être sautées ; dans ce cas seules les lignes ancrées par des nombres sont fiables.
const alignMemo = new Map();
export function alignLines(enText, frText) {
  const memoKey = enText + '\u0000' + frText;
  if (!alignMemo.has(memoKey)) alignMemo.set(memoKey, alignLinesUncached(enText, frText));
  return alignMemo.get(memoKey);
}

function alignLinesUncached(enText, frText) {
  const E = enText.split('\n').map(s => s.trim()), F = frText.split('\n').map(s => s.trim());
  const n = E.length, m = F.length, INF = 1e9;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const back = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  dp[0][0] = 0;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= m; j++) {
    const c = dp[i][j]; if (c >= INF) continue;
    const relax = (i2, j2, cost, step) => { if (c + cost < dp[i2][j2]) { dp[i2][j2] = c + cost; back[i2][j2] = { i, j, step }; } };
    if (j < m && F[j] === '') relax(i, j + 1, 1, 'fr-blank');
    if (i < n && E[i] === '') relax(i + 1, j, 1, 'en-blank');
    if (i < n && j < m && E[i] === '' && F[j] === '') relax(i + 1, j + 1, 0, 'blank');
    if (i < n && E[i] !== '') relax(i + 1, j, 3, 'skip');
    if (j < m && F[j] !== '') relax(i, j + 1, 3, 'skip');
    if (i < n && E[i] !== '') {
      const maxK = /\d/.test(E[i]) ? 3 : 1;
      for (let k = 1; k <= maxK && j + k <= m; k++) {
        const seg = F.slice(j, j + k);
        if (seg.some(s => s === '')) break;
        if (matchNumbers(enNumbers(E[i]), frNumbers(seg.join('\n')))) relax(i + 1, j + k, k - 1, { en: E[i], fr: seg.join('\n') });
      }
    }
  }
  if (dp[n][m] >= INF) return null;
  const out = []; let skips = 0;
  for (let i = n, j = m; i || j;) { const b = back[i][j]; if (typeof b.step === 'object') out.unshift(b.step); else if (b.step === 'skip') skips++; i = b.i; j = b.j; }
  return skips ? out.filter(p => /\d/.test(p.en)) : out;
}

export function styleOf(fiche) {
  const s = JSON.stringify([fiche['attaque_normale'], fiche['compétences'], fiche['ultime'], fiche['compétences_auto'], fiche['ultime_coopérative']]);
  const a = (s.match(/équivalant à|ennemis? ciblés?|Applique une (?:augmentation|baisse)/g) || []).length;
  const b = (s.match(/ennemi sélectionné|Inflige [\d,]+\s%|(?:"|\\n)(?:Augmente|Diminue) (?:son|sa|ses|le|la|les) /g) || []).length;
  return a >= b ? 'A' : 'B';
}

// Variantes FR admissibles (vues dans au moins `minFiches` fiches, sans marqueur du style écarté), de la meilleure à la moins bonne :
// le plus de fiches de style A, puis une tournure du style A, puis le plus de fiches.
function ranked(variants, minFiches) {
  return [...variants.entries()]
    .map(([fr, v]) => ({ fr, fiches: v.fiches.size, a: v.styleA.size, aMark: STYLE_A.test(fr) ? 1 : 0, set: v.fiches }))
    .filter(x => x.fiches >= minFiches && !STYLE_B.test(x.fr) && !LIST_ITEM.test(x.fr))
    .sort((x, y) => y.a - x.a || y.aMark - x.aMark || y.fiches - x.fiches || (x.fr < y.fr ? -1 : 1));
}

// Portion qui diffère entre deux phrases FR, élargie aux limites de mots ; null si vide ou trop large.
function frDiff(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (p > 0 && isWord(a[p - 1]) && (isWord(a[p]) || isWord(b[p]))) p--;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  while (s > 0 && isWord(a[a.length - s]) && (isWord(a[a.length - s - 1]) || isWord(b[b.length - s - 1]))) s--;
  const fa = a.slice(p, a.length - s).trim(), fb = b.slice(p, b.length - s).trim();
  const ok = f => f && f.length <= 80 && !/[{}\n]/.test(f);
  return ok(fa) && ok(fb) ? [fa, fb] : null;
}

// Composition : équivalents FR des fragments (paires minimales) puis cadres (lignes connues dont des fragments sont retirés).
function learnFragments(patterns, minFiches) {
  const tokenize = tokenizer(VOCABULAIRE);
  const groups = new Map();
  for (const p of patterns) {
    p.tokens = tokenize(p.key);
    p.occ = p.tokens.filter(t => t.cls);
    if (!p.occ.length || p.occ.length > 6) continue;
    const sig = lookupKey(frameKey(p.tokens, p.occ.map((_, i) => i)).key);
    groups.set(sig, [...(groups.get(sig) || []), p]);
  }
  // votes[classe][valeur] : équivalent FR → cadres EN (signatures) qui le confirment
  const votes = {};
  const vote = (cls, value, fr, sig) => { const v = ((votes[cls] ||= {})[value] ||= new Map()); v.set(fr, (v.get(fr) || new Set()).add(sig)); };
  for (const [sig, g] of groups) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
    const diff = g[i].occ.map((o, k) => (o.value !== g[j].occ[k].value ? k : -1)).filter(k => k >= 0);
    if (diff.length !== 1) continue;
    const d = frDiff(g[i].fr, g[j].fr);
    if (!d) continue;
    vote(g[i].occ[diff[0]].cls, g[i].occ[diff[0]].value, d[0], sig);
    vote(g[j].occ[diff[0]].cls, g[j].occ[diff[0]].value, d[1], sig);
  }
  // Un équivalent n'est retenu que s'il est confirmé par au moins deux cadres EN différents et par au moins 2/3 des votes.
  // Un vote plus large qui le contient tel quel (« au corps à corps à l'ennemi ciblé ») le confirme aussi.
  const valeurs = {};
  for (const [cls, byValue] of Object.entries(votes)) for (const [value, m] of Object.entries(byValue)) {
    const all = [...m].map(([fr, sigs]) => ({ fr, sigs }));
    const total = new Set(all.flatMap(x => [...x.sigs])).size;
    const ranked = all.map(c => ({ fr: c.fr, n: new Set(all.filter(x => uniqueWordIndex(x.fr, c.fr) >= 0).flatMap(x => [...x.sigs])).size }))
      .sort((a, b) => b.n - a.n || a.fr.length - b.fr.length || (a.fr < b.fr ? -1 : 1));
    if (process.env.FRAG_DEBUG) console.log(`${cls} « ${value} » (${total}) : ${ranked.map(r => `${r.fr} ×${r.n}`).join(' | ')}`);
    if (ranked[0].n >= 2 && ranked[0].n * 3 >= total * 2) (valeurs[cls] ||= {})[value] = ranked[0].fr;
  }

  const frames = new Map();
  for (const p of patterns) {
    if (!p.occ?.length || p.occ.length > 6) continue;
    const spans = p.occ.map(o => { const f = valeurs[o.cls]?.[o.value]; const at = f ? uniqueWordIndex(p.fr, f) : -1; return at >= 0 ? { at, len: f.length } : null; });
    const usable = spans.map((s, i) => (s ? i : -1)).filter(i => i >= 0);
    for (const sub of subsets(usable.length)) {
      const mask = sub.map(i => usable[i]);
      const parts = mask.map(i => spans[i]).sort((a, b) => a.at - b.at);
      if (parts.some((s, k) => k && parts[k - 1].at + parts[k - 1].len > s.at)) continue;
      const { key, slots } = frameKey(p.tokens, mask);
      let fr = p.fr;
      mask.map((i, k) => ({ ...spans[i], name: slots[k].name })).sort((a, b) => b.at - a.at)
        .forEach(s => { fr = fr.slice(0, s.at) + `{${s.name}}` + fr.slice(s.at + s.len); });
      const lk = lookupKey(key);
      const variants = frames.get(lk) || { key, byFr: new Map() };
      const v = variants.byFr.get(fr) || { fiches: new Set(), valeurs: {} };
      p.fiches.forEach(f => v.fiches.add(f));
      slots.forEach(s => (v.valeurs[s.name] ||= new Set()).add(s.value));
      variants.byFr.set(fr, v); frames.set(lk, variants);
    }
  }
  const cadres = {}, compat = {};
  for (const { key, byFr } of frames.values()) {
    const [fr, v] = [...byFr].sort((a, b) => b[1].fiches.size - a[1].fiches.size || (a[0] < b[0] ? -1 : 1))[0];
    if (v.fiches.size < minFiches) continue;
    cadres[key] = { 'fr': fr, 'valeurs_vues': Object.fromEntries(Object.entries(v.valeurs).map(([k, s]) => [k, [...s].sort()])), 'fiches': v.fiches.size };
    // valeurs vues interchangeables dans un même cadre FR : leurs équivalents ont la même granularité
    for (const [slot, s] of Object.entries(v.valeurs)) {
      const cls = slot.split('#')[0];
      for (const a of s) for (const b of s) if (a !== b) ((compat[cls] ||= {})[a] ||= new Set()).add(b);
    }
  }
  const compatibles = Object.fromEntries(Object.entries(compat).map(([cls, m]) => [cls, Object.fromEntries(Object.entries(m).map(([a, s]) => [a, [...s].sort()]))]));
  return { 'vocabulaire': VOCABULAIRE, 'valeurs': valeurs, 'compatibles': compatibles, 'cadres': cadres };
}

export function derive(pairsByFiche, { minFiches = 2 } = {}) {
  // Clés regroupées sans tenir compte de la casse ; la graphie conservée est la première rencontrée.
  const lineVariants = new Map(), nameVariants = new Map(), spelling = new Map();
  let blocks = 0, aligned = 0;
  const add = (map, k, fr, fiche, style) => {
    const v = map.get(k) || new Map(); const e = v.get(fr) || { fiches: new Set(), styleA: new Set() };
    e.fiches.add(fiche['titre']); if (style === 'A') e.styleA.add(fiche['titre']); v.set(fr, e); map.set(k, v);
  };
  for (const { fiche, pairs, style } of pairsByFiche) {
    for (const p of pairs) {
      if (p.where === 'nom_auto') { add(nameVariants, p.en, p.fr, fiche, style); continue; }
      blocks++;
      const al = alignLines(p.en, p.fr);
      if (!al) continue;
      aligned++;
      for (const { en, fr } of al) {
        const { key, nums } = abstractLine(en);
        const tpl = frTemplate(fr, nums);
        if (tpl == null) continue;
        const lk = lookupKey(key);
        if (!spelling.has(lk)) spelling.set(lk, key);
        add(lineVariants, lk, tpl, fiche, style);
      }
    }
  }
  const lignes = {}, noms = {}, chosen = [], patterns = [];
  for (const [lk, v] of lineVariants) {
    const r = ranked(v, 1);
    if (r[0]) patterns.push({ key: spelling.get(lk), fr: r[0].fr, fiches: r[0].set });
    const c = r.find(x => x.fiches >= minFiches);
    if (c) { lignes[spelling.get(lk)] = c.fr; chosen.push({ key: spelling.get(lk), ...c, variants: v.size }); }
  }
  for (const [en, v] of nameVariants) { const c = ranked(v, minFiches)[0]; if (c && c.fr !== en) noms[en] = c.fr; }
  const fragments = learnFragments(patterns, minFiches);
  return { lignes, noms, fragments, chosen, blocks, aligned, keys: lineVariants.size };
}

function majority(pairs) {
  const t = new Map();
  for (const [en, fr] of pairs) { if (en == null || fr == null || fr === '') continue; const m = t.get(en) || new Map(); m.set(fr, (m.get(fr) || 0) + 1); t.set(en, m); }
  return Object.fromEntries([...t].sort(([a], [b]) => a.localeCompare(b)).map(([en, m]) => [en, [...m].sort((a, b) => b[1] - a[1])[0][0]]));
}

// Évaluation « leave-one-out » : chaque fiche est traduite avec le glossaire dérivé des autres.
function leaveOneOut(pairsByFiche) {
  const shape = s => s.replace(/\d+(?:,\d+)?/g, '#');   // le FR existant est souvent plus précis que le wiki (74,67 contre 74,7)
  const st = { lines: 0, glossaire: 0, composée: 0, same: { glossaire: [0, 0], composée: [0, 0] } }, missing = new Map(), examples = [];
  for (const target of pairsByFiche) {
    const others = derive(pairsByFiche.filter(p => p !== target));
    const tr = createTranslator({ lignes: others.lignes, fragments: others.fragments });
    for (const p of target.pairs) {
      if (p.where === 'nom_auto') continue;
      for (const d of tr.translate(p.en).lines) {
        if (!d.en.trim()) continue;
        st.lines++;
        if (d.source === 'glossaire' || d.source === 'composée') st[d.source]++;
        else { const k = lookupKey(abstractLine(d.en).key); missing.set(k, (missing.get(k) || 0) + 1); }
      }
      if (target.style !== 'A') continue;
      for (const { en, fr } of alignLines(p.en, p.fr) || []) {
        const d = tr.translate(en).lines[0];
        if (!d || !st.same[d.source]) continue;
        const ok = shape(d.fr) === shape(fr);
        st.same[d.source][0] += ok ? 1 : 0; st.same[d.source][1]++;
        if (d.source === 'composée') examples.push({ fiche: target.fiche['titre'], en, produit: d.fr, existant: fr, cadre: d.cadre, ok });
      }
    }
  }
  return { st, missing, examples };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const dataPath = path.resolve(opt('--data') || path.join(ROOT, 'data', 'characters.json'));
  const outPath = path.resolve(opt('--out') || path.join(ROOT, 'data', 'glossaire.json'));
  const fiches = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  const client = createClient({ cacheDir: opt('--cache'), log: console.log });
  const wiki = await loadWiki(client, [...fiches.map(f => f['page_wiki']), ...fiches.map(f => titleFromUrl(f['url_wiki']))].filter(Boolean));
  const matches = matchFiches(fiches, wiki).filter(r => r.title && r.exists);
  const pairsByFiche = matches.map(r => ({ fiche: r.fiche, w: wiki.wikiParams[r.title], pairs: textPairs(r.fiche, wiki.wikiParams[r.title]), style: styleOf(r.fiche) }));
  console.log(`${matches.length} paires EN/FR (style A : ${pairsByFiche.filter(p => p.style === 'A').length}, style B : ${pairsByFiche.filter(p => p.style === 'B').length}) — ${client.calls} appels API`);

  const d = derive(pairsByFiche);
  console.log(`Motifs de ligne retenus (≥ 2 fiches, style majoritaire) : ${Object.keys(d.lignes).length} sur ${d.keys} observés`);
  console.log(`Fragments : ${Object.values(d.fragments.valeurs).reduce((n, v) => n + Object.keys(v).length, 0)} équivalents appris, ${Object.keys(d.fragments.cadres).length} cadres (≥ 2 fiches)`);

  if (!args.includes('--sans-evaluation')) {
    const { st, missing, examples } = leaveOneOut(pairsByFiche);
    const pct = (a, b) => `${Math.round(100 * a / b)} %`;
    console.log(`\nLeave-one-out sur ${st.lines} lignes EN :`);
    console.log(`  traduites par motif de ligne : ${pct(st.glossaire, st.lines)}, composées : ${pct(st.composée, st.lines)}, total : ${pct(st.glossaire + st.composée, st.lines)}`);
    console.log(`  même tournure que le FR existant (fiches style A, nombres exclus) : motifs ${st.same.glossaire[0]}/${st.same.glossaire[1]} (${pct(...st.same.glossaire)}), composées ${st.same.composée[0]}/${st.same.composée[1]} (${pct(...st.same.composée)})`);
    if (process.env.GLOSSAIRE_MISSING) {
      console.log('\nLignes EN les plus fréquentes restées en anglais :');
      [...missing].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.GLOSSAIRE_MISSING)).forEach(([k, n]) => console.log(`  ${n}× ${k}`));
    }
    if (process.env.GLOSSAIRE_COMPOSEES) {
      const seen = new Set();
      for (const e of examples.filter(e => !seen.has(abstractLine(e.en).key) && seen.add(abstractLine(e.en).key)).slice(0, Number(process.env.GLOSSAIRE_COMPOSEES)))
        console.log(`\n[${e.ok ? 'identique' : 'différente'}] ${e.fiche}\n  EN       : ${e.en}\n  cadre    : ${e.cadre}\n  composée : ${e.produit.replace(/\n/g, ' ⏎ ')}\n  existant : ${e.existant.replace(/\n/g, ' ⏎ ')}`);
    }
  }

  const vals = (k, f) => pairsByFiche.map(({ fiche, w }) => [w[k] == null ? null : cleanWikitext(w[k]), f(fiche)]);
  const previous = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const sorted = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const glossaire = {
    '_à_propos': 'Généré par scripts/derive-glossaire.mjs à partir des fiches existantes rapprochées du wiki. « lignes » : motifs de ligne EN → FR ({0}, {1}… = nombres, recopiés au format français). « fragments » : équivalents FR de fragments interchangeables et cadres de ligne ; une ligne n\'est composée que si tous ses fragments sont connus. Les sections « *_manuel(le)s » ne sont jamais écrasées et priment sur les sections dérivées ; une valeur null y signifie « laisser en anglais ». « termes_manuels » : vocabulaire EN → FR imposé à DeepL ; « corrections_deepl » : [motif regex, remplacement] appliqués aux traductions DeepL (ni l\'un ni l\'autre n\'est écrasé).',
    'valeurs': {
      'élément': majority(vals('Type', f => f['élément'])),
      'rôle': ROLE,
      'spécialité': SPECIALITE,
      'affiliation': majority(vals('Affiliation', f => f['affiliation'])),
      'rayon_noir': RAYON_NOIR,
      'limité': LIMITE,
    },
    'noms': sorted(d.noms),
    'lignes': sorted(d.lignes),
    'fragments': { ...d.fragments, 'cadres': sorted(d.fragments.cadres) },
    'valeurs_manuelles': previous['valeurs_manuelles'] || { 'affiliation': { 'Curse User': null } },
    'lignes_manuelles': previous['lignes_manuelles'] || {},
    'noms_manuels': previous['noms_manuels'] || {},
    'fragments_manuels': previous['fragments_manuels'] || {},
    'termes_manuels': previous['termes_manuels'] || {},
    'corrections_deepl': previous['corrections_deepl'] || [],
  };
  if (args.includes('--dry-run')) { console.log('\n--dry-run : glossaire non écrit.'); return; }
  fs.writeFileSync(outPath, JSON.stringify(glossaire, null, 2) + '\n');
  console.log(`\nÉcrit : ${outPath} (${Object.keys(glossaire.lignes).length} lignes, ${Object.keys(glossaire.fragments.cadres).length} cadres, ${Object.keys(glossaire.noms).length} noms)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
