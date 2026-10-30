#!/usr/bin/env node
// Synchronise data/characters.json avec le JJK - Phantom Parade Wiki (Fandom, CC BY-SA 3.0) via l'API MediaWiki.
//
// Règles de fusion :
//  - fiches existantes : seules les valeurs numériques de « statistiques » sont mises à jour ; aucun texte FR n'est touché.
//    S'y ajoutent, à la demande du mainteneur : page_wiki, date au format JJ-MM-AAAA, icône hébergée par le wiki.
//  - rapprochement : page_wiki (fait foi) > url_wiki > clé_icône = UnitN > clé_image = Card Art (unique des deux côtés).
//    Tout cas incertain (conflit, fiche sans correspondance, page ressemblante) va dans le rapport sans être fusionné.
//  - nouveaux personnages : construits depuis le wiki et traduits via data/glossaire.json (+ DeepL si DEEPL_API_KEY).
//  - catégories (data/categories.json) : tout rôle qui n'y figure pas, sur une fiche sans champ « catégories », est signalé.
//
// Usage : node scripts/sync-wiki.mjs [--dry-run] [--report <fichier.md>] [--commit-message <fichier>]
//         [--data <characters.json>] [--glossaire <glossaire.json>] [--deepl-cache <fichier.json>] [--cache <dossier>]
//         [--categories <categories.json>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, loadWiki, fetchImageUrls, cleanWikitext, isBlank, WIKI, USER_AGENT } from './lib/wiki.mjs';
import { matchFiches, wikiKit, ignoredParams, parseStat, normalizeDate, blackFlash, titleFromUrl, STATS } from './lib/fiches.mjs';
import { createTranslator } from './lib/traduction.mjs';
import { loadDotEnv, readCache, writeCache, translateKeys, DEEPL_URL } from './lib/deepl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const DRY = args.includes('--dry-run');
const DATA = path.resolve(opt('--data', path.join(ROOT, 'data', 'characters.json')));
const GLOSSAIRE = path.resolve(opt('--glossaire', path.join(ROOT, 'data', 'glossaire.json')));
const DEEPL_CACHE = path.resolve(opt('--deepl-cache', path.join(ROOT, 'data', 'traductions-deepl.json')));
const CATEGORIES = path.resolve(opt('--categories', path.join(ROOT, 'data', 'categories.json')));
const REPORT = path.resolve(opt('--report', path.join(ROOT, 'sync-report.md')));
const COMMIT_MESSAGE = opt('--commit-message', null);
const MIN_WIKI_PAGES = 50;   // garde-fou : en dessous, le wiki est probablement indisponible ou vandalisé

const pageUrl = title => `${WIKI}/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`;
const link = title => `[${title}](${pageUrl(title)})`;
const dateKey = d => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(d || ''); return m ? `${m[3]}${m[2]}${m[1]}` : '00000000'; };

// Icônes : le modèle de liste essaie .png, puis .jpg, puis .jpeg.
async function iconUrls(client, units) {
  const found = {};
  let missing = [...new Set(units)];
  for (const ext of ['png', 'jpg', 'jpeg']) {
    if (!missing.length) break;
    const urls = await fetchImageUrls(client, missing.map(u => `${u}.${ext}`));
    for (const u of missing) if (urls[`${u}.${ext}`]) found[u] = urls[`${u}.${ext}`];
    missing = missing.filter(u => !found[u]);
  }
  return found;
}

// Kit traduit d'une nouvelle fiche + lignes à relire (composées, DeepL) + statistiques de traduction.
function translateKit(kit, tr) {
  const review = { 'composées': [], 'deepl': [] };
  const count = { lignes: 0, glossaire: 0, manuel: 0, composée: 0, deepl: 0, anglais: 0 };
  const text = (value, champ) => {
    const r = tr.translate(value);
    for (const d of r.lines) {
      count.lignes++; count[d.source]++;
      if (d.source === 'composée') review['composées'].push({ 'champ': champ, 'ligne': d.n, 'en': d.en });
      if (d.source === 'deepl') review['deepl'].push({ 'champ': champ, 'ligne': d.n, 'en': d.en });
    }
    return r.text;
  };
  const name = (value, champ) => {
    const r = tr.nameInfo(value);
    if (r.source === 'deepl') review['deepl'].push({ 'champ': champ, 'en': value });
    return r.fr;
  };
  const EFFECTS = ['effet', 'effet_niv10', 'modifié_effet', 'modifié_effet_niv10', 'effet_renforcé'];
  const block = (b, champ) => Object.fromEntries(Object.entries(b).map(([k, v]) =>
    [k, EFFECTS.includes(k) && typeof v === 'string' ? text(v, `${champ}.${k}`) : k === 'nom' ? name(v, `${champ}.nom`) : v]));
  const out = {
    'attaque_normale': block(kit['attaque_normale'], 'attaque_normale'),
    'compétences': kit['compétences'].map((c, i) => block(c, `compétences[${i}]`)),
    'ultime': block(kit['ultime'], 'ultime'),
    'compétences_auto': kit['compétences_auto'].map((c, i) => block(c, `compétences_auto[${i}]`)),
    'ultime_coopérative': block(kit['ultime_coopérative'], 'ultime_coopérative'),
  };
  return { kit: out, review, count, name };
}

function buildFiche(title, w, unit, iconUrl, tr) {
  const m = /^\((.*)\)\s*(.*)$/.exec(title);
  const untranslated = [];
  const value = (table, raw, fallback = raw) => {
    if (raw == null) return fallback;
    const v = tr.value(table, raw);
    if (v == null) untranslated.push(`${table} « ${raw} »`);
    return v ?? fallback;
  };
  const role = cleanWikitext(w['Role']), focus = cleanWikitext(w['Focus']), aff = isBlank(w['Affiliation']) ? null : cleanWikitext(w['Affiliation']);
  const { kit, notes } = wikiKit(w);
  const t = translateKit(kit, tr);
  const statistiques = Object.fromEntries(STATS.map(([k, wk]) => [k, parseStat(w[wk])]));
  statistiques['rayon_noir'] = value('rayon_noir', blackFlash(w), 'N/D');
  const fiche = {
    'titre': title,
    'nom': cleanWikitext(w['Card Name']) || (m ? m[2] : title),
    'épithète': m ? t.name(m[1], 'épithète') : null,
    'rareté': cleanWikitext(w['Rarity']),
    'élément': value('élément', cleanWikitext(w['Type'])),
    'rôle': value('rôle', role),
    'spécialité': value('spécialité', focus),
    'affiliation': value('affiliation', aff, aff),
    'date_de_sortie': normalizeDate(cleanWikitext(w['Release Date'])) ?? cleanWikitext(w['Release Date']),
    'limité': tr.value('limité', isBlank(w['Limited-Yes']) ? null : cleanWikitext(w['Limited-Yes'])) ?? false,
    'statistiques': statistiques,
    ...t.kit,
    'étiquettes': [],
    'clé_image': cleanWikitext(w['Card Art']) || null,
    'clé_icône': unit,
    'url_icône': iconUrl,
  };
  if (t.review['composées'].length || t.review['deepl'].length)
    fiche['traduction_automatique'] = Object.fromEntries(Object.entries(t.review).filter(([, v]) => v.length));
  fiche['page_wiki'] = title;
  const badStats = STATS.filter(([k]) => statistiques[k] == null).map(([, wk]) => `${wk} = « ${w[wk] ?? ''} »`);
  return { fiche, count: t.count, review: t.review, untranslated, notes, badStats, ignored: ignoredParams(w) };
}

async function main() {
  loadDotEnv(path.join(ROOT, '.env'));
  const fiches = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const glossaire = JSON.parse(fs.readFileSync(GLOSSAIRE, 'utf8'));
  const categoryRoles = JSON.parse(fs.readFileSync(CATEGORIES, 'utf8'))['catégories'] || {};
  const snapshot = fiches.map(f => JSON.stringify(f));
  const client = createClient({ cacheDir: opt('--cache', null), log: console.log });
  const say = s => console.log(s);

  // ---- Lecture du wiki ----
  say(`Lecture du wiki (${USER_AGENT})…`);
  const extra = [...fiches.map(f => f['page_wiki']), ...fiches.map(f => titleFromUrl(f['url_wiki']))].filter(Boolean);
  const wiki = await loadWiki(client, extra);
  const pageCount = Object.keys(wiki.wikiParams).length;
  if (pageCount < MIN_WIKI_PAGES) throw new Error(`Seulement ${pageCount} fiches lues sur le wiki (minimum attendu : ${MIN_WIKI_PAGES}) : synchro annulée.`);

  // ---- Rapprochement ----
  const results = matchFiches(fiches, wiki);
  const matchedTitles = new Set(results.filter(r => r.title).map(r => r.title));
  const conflictTitles = new Set(results.filter(r => r.conflict).flatMap(r => r.found.flatMap(x => x.title ? [x.title] : x.ambiguous || [])));
  const units = results.filter(r => r.unit).map(r => r.unit);

  // ---- Nouvelles pages ----
  const unmatched = results.filter(r => !r.title);
  const proposals = [], newPages = [];
  const typeFr = t => glossaire['valeurs']?.['élément']?.[t] ?? t;
  for (const [title, w] of Object.entries(wiki.wikiParams)) {
    if (matchedTitles.has(title) || conflictTitles.has(title)) continue;
    const look = unmatched.filter(r => r.fiche['nom'] === cleanWikitext(w['Card Name']) && r.fiche['rareté'] === w['Rarity'] && r.fiche['élément'] === typeFr(w['Type']));
    if (look.length) { proposals.push({ title, fiches: look.map(r => r.fiche['titre']) }); continue; }
    const entry = wiki.listEntries.find(e => (wiki.resolved[e.title]?.title ?? e.title) === title && e.unit);
    newPages.push({ title, w, unit: entry?.unit ?? null });
  }
  const icons = await iconUrls(client, [...units, ...newPages.map(p => p.unit).filter(Boolean)]);

  // ---- Fiches existantes ----
  const rn = glossaire['valeurs']?.['rayon_noir'] || {};
  const report = { changes: new Map(), unreadable: [], rayonNoir: [], badDates: [], iconsKept: [], iconsMissing: [], redLinks: [], warnings: [], conflicts: [], noMatch: [], bigChanges: [] };
  const change = (f, field, detail) => { const k = f['titre']; report.changes.set(k, [...(report.changes.get(k) || []), { field, detail }]); };
  for (const r of results) {
    const f = r.fiche, titre = f['titre'];
    // page_wiki
    let page = r.title && r.exists ? r.title : (r.method === 'page_wiki' ? f['page_wiki'] : null);
    if (r.method === 'page_wiki' && !r.exists) report.warnings.push(`${titre} : page_wiki « ${f['page_wiki']} » introuvable sur le wiki (conservé)`);
    if (r.conflict) { page = f['page_wiki'] ?? null; report.conflicts.push(`${titre} : ${r.conflict}`); }
    if (r.warning) report.warnings.push(`${titre} : ${r.warning}`);
    if (r.title && !r.exists && r.method !== 'page_wiki') report.redLinks.push(`${titre} → « ${r.title} » (rapprochée par ${r.method})`);
    if (!r.title && !r.conflict) report.noMatch.push(`${titre} [clé_icône ${f['clé_icône']}, clé_image ${f['clé_image']}]`);
    if (!('page_wiki' in f) || f['page_wiki'] !== page) { change(f, 'page_wiki', page ? `« ${page} »` : 'null'); f['page_wiki'] = page; }
    // statistiques numériques
    if (r.title && r.exists) {
      const w = wiki.wikiParams[r.title];
      for (const [k, wk] of STATS) {
        if (isBlank(w[wk])) continue;
        const v = parseStat(w[wk]);
        if (v == null) { report.unreadable.push(`${titre} : ${wk} = « ${w[wk]} » (valeur non appliquée)`); continue; }
        const old = f['statistiques']?.[k];
        if (old !== v) {
          change(f, k, `${old ?? '∅'} → ${v}`);
          if (typeof old === 'number' && old > 0 && Math.abs(v - old) / old > 0.3) report.bigChanges.push(`${titre} : ${k} ${old} → ${v}`);
          f['statistiques'][k] = v;
        }
      }
      const bf = blackFlash(w);
      if ((bf === 'Yes' || bf === 'No') && rn[bf] !== f['statistiques']?.['rayon_noir']) report.rayonNoir.push(`${titre} : ${f['statistiques']?.['rayon_noir']} sur le site, ${bf} sur le wiki`);
    }
    // date
    const d = normalizeDate(f['date_de_sortie']);
    if (d == null) report.badDates.push(`${titre} : « ${f['date_de_sortie']} »`);
    else if (d !== f['date_de_sortie']) { change(f, 'date_de_sortie', `${f['date_de_sortie']} → ${d}`); f['date_de_sortie'] = d; }
    // icône
    if (r.unit && icons[r.unit]) { if (f['url_icône'] !== icons[r.unit]) { change(f, 'url_icône', 'icône du wiki'); f['url_icône'] = icons[r.unit]; } }
    else if (r.unit) report.iconsMissing.push(`${titre} : fichier « ${r.unit} » (.png/.jpg/.jpeg) introuvable sur le wiki`);
    else report.iconsKept.push(`${titre} : ${f['url_icône']}`);
  }

  // ---- Nouvelles fiches (2 passes si DeepL est configuré) ----
  const deeplKey = process.env.DEEPL_API_KEY || '';
  let deepl = readCache(DEEPL_CACHE), deeplNote = null, deeplNew = 0;
  const corrections = glossaire['corrections_deepl'] || [];
  const build = () => {
    const tr = createTranslator(glossaire, { deepl: deepl.lignes, deeplNames: deepl.noms });
    const built = newPages.map(p => ({ ...p, ...buildFiche(p.title, p.w, p.unit, p.unit ? icons[p.unit] ?? null : null, tr) }));
    return { tr, built };
  };
  let { tr, built } = build();
  const pendingCount = () => tr.pending.size + tr.pendingNames.size;
  if (pendingCount() && deeplKey) {
    // Noms d'abord : une fois traduits, ils sont protégés dans les lignes qui les citent (« "Projection Sorcery" State… »).
    const url = process.env.DEEPL_API_URL || DEEPL_URL;
    const errors = [];
    for (const [section, pending] of [['noms', () => [...tr.pendingNames]], ['lignes', () => [...tr.pending.values()]]]) {
      const keys = pending().filter(k => !(k in deepl[section]));
      if (!keys.length) continue;
      say(`DeepL : ${keys.length} ${section === 'noms' ? 'nom(s)' : 'ligne(s)'} à traduire…`);
      const res = await translateKeys(keys, { apiKey: deeplKey, url, terms: tr.terms(), corrections: section === 'lignes' ? corrections : [], log: say });
      const n = Object.keys(res.translations).length;
      deeplNew += n;
      if (res.error) errors.push(`${res.error} — ${n} ${section === 'noms' ? 'nom(s)' : 'ligne(s)'} traduit(e)s avant l'erreur, les autres restent en anglais.`);
      if (n) { deepl = { ...deepl, [section]: { ...deepl[section], ...res.translations } }; ({ tr, built } = build()); }
      if (res.error) break;
    }
    if (errors.length) deeplNote = errors.join(' ');
  } else if (pendingCount()) deeplNote = `DEEPL_API_KEY absent : ${tr.pending.size} ligne(s) et ${tr.pendingNames.size} nom(s) distinct(s) restent en anglais.`;
  built.sort((a, b) => dateKey(b.fiche['date_de_sortie']).localeCompare(dateKey(a.fiche['date_de_sortie'])));
  const added = built.map(b => b.fiche);
  const result = [...added, ...fiches];

  // ---- Catégories : rôle absent de data/categories.json (la fiche n'apparaît que sous « Tous ») ----
  const known = new Set(Object.values(categoryRoles).flat());
  const categoryNames = new Set(Object.keys(categoryRoles));
  const uncategorized = [];
  for (const f of result) {
    const override = Array.isArray(f['catégories']) && f['catégories'].length ? f['catégories'] : null;
    if (override) { const bad = override.filter(c => !categoryNames.has(c)); if (bad.length) uncategorized.push(`${f['titre']} : catégories inconnues ${bad.map(c => `« ${c} »`).join(', ')}`); }
    else if (!known.has(f['rôle'])) uncategorized.push(`${f['titre']} : ${f['rôle'] ? `rôle « ${f['rôle']} » absent de data/categories.json` : 'rôle vide'}`);
  }
  // Spécialité vide : la fiche n'apparaît que sous « Tous » pour ce filtre.
  const noSpeciality = result.filter(f => !String(f['spécialité'] ?? '').trim()).map(f => f['titre']);

  // ---- Écritures ----
  const modified = fiches.filter((f, i) => JSON.stringify(f) !== snapshot[i]);
  const changed = added.length > 0 || modified.length > 0;
  if (!DRY && changed) fs.writeFileSync(DATA, JSON.stringify(result, null, 2) + '\n');
  if (!DRY && deeplNew) writeCache(DEEPL_CACHE, deepl);

  // ---- Rapport ----
  const md = [];
  const list = (items, max = 400) => items.slice(0, max).map(x => `- ${x}`).concat(items.length > max ? [`- … et ${items.length - max} autre(s)`] : []);
  const section = (title, items, open = false) => { if (!items.length) return; md.push(`<details${open ? ' open' : ''}><summary><b>${title}</b> (${items.length})</summary>\n`, ...list(items), '\n</details>\n'); };
  const withPage = results.filter(r => r.title && r.exists).length;
  md.push(`# Rapport de synchro wiki — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC\n`);
  md.push(`Source : [JJK - Phantom Parade Wiki](${WIKI}) (CC BY-SA 3.0), ${client.calls} appel(s) API.${DRY ? ' **Simulation (--dry-run) : rien n\'a été écrit.**' : ''}\n`);
  md.push(`| | |\n|---|---|\n| Fiches du site | ${fiches.length} |\n| Fiches de personnage sur le wiki | ${pageCount} |\n| Fiches rapprochées d'une page | ${withPage} |\n| Fiches ajoutées | ${added.length} |\n| Fiches modifiées | ${modified.length} |\n| À vérifier (conflits, sans correspondance, propositions, catégories, spécialités) | ${report.conflicts.length + report.noMatch.length + proposals.length + uncategorized.length + noSpeciality.length} |\n`);
  if (added.length) {
    md.push('## Fiches ajoutées\n');
    for (const b of built) {
      const c = b.count, pct = n => c.lignes ? `${Math.round(100 * n / c.lignes)} %` : '—';
      md.push(`### ${b.fiche['titre']}\n`);
      md.push(`${link(b.title)} · ${b.fiche['rareté']} · ${b.fiche['élément']} · sortie ${b.fiche['date_de_sortie']} · icône : ${b.fiche['url_icône'] ? 'wiki' : '**introuvable**'}\n`);
      md.push(`Traduction : ${c.lignes} lignes — glossaire ${pct(c.glossaire + c.manuel)}, composées ${pct(c.composée)}, DeepL ${pct(c.deepl)}, restées en anglais ${pct(c.anglais)}.\n`);
      if (b.untranslated.length) md.push(`Valeurs laissées en anglais : ${b.untranslated.join(', ')}.\n`);
      if (b.ignored.length) md.push(`Paramètres ignorés (non repris) : ${b.ignored.join(', ')}.\n`);
      if (b.notes.length) md.push(`Valeurs annotées : ${b.notes.join(' ; ')}.\n`);
      if (b.badStats.length) md.push(`**Statistiques illisibles** : ${b.badStats.join(' ; ')}.\n`);
      section('Lignes composées à relire', b.review['composées'].map(x => `\`${x.champ}\` l. ${x.ligne} — ${x.en}`), true);
      section('Lignes et noms traduits par DeepL à relire', b.review['deepl'].map(x => `\`${x.champ}\`${x.ligne ? ` l. ${x.ligne}` : ''} — ${x.en}`), true);
    }
  }
  md.push('## À vérifier\n');
  section('Conflits de rapprochement (non fusionnés)', report.conflicts, true);
  section('Fiches sans correspondance sur le wiki (renseigner page_wiki à la main)', report.noMatch, true);
  section('Fiches sans catégorie (visibles seulement sous « Tous » : compléter data/categories.json ou le champ « catégories »)', uncategorized, true);
  section('Fiches à spécialité vide (visibles seulement sous « Tous » pour la spécialité)', noSpeciality, true);
  section('Pages wiki ressemblant à une fiche non rapprochée (non ajoutées)', proposals.map(p => `${link(p.title)} ↔ ${p.fiches.map(t => `« ${t} »`).join(', ')}`), true);
  section('Avertissements', report.warnings, true);
  section('Valeurs illisibles (non appliquées)', report.unreadable, true);
  section('Variations de statistiques supérieures à 30 % (appliquées, à contrôler)', report.bigChanges, true);
  section('Dates illisibles (laissées telles quelles)', report.badDates, true);
  section('Icônes introuvables sur le wiki (URL actuelle conservée)', report.iconsMissing, true);
  if (deeplNote) md.push(`> DeepL : ${deeplNote}\n`);
  md.push('## Pour information\n');
  section('Fiches rapprochées d\'un lien rouge (page wiki inexistante, rien à synchroniser)', report.redLinks);
  section('Icônes conservées faute de correspondance', report.iconsKept);
  section('Rayon Noir : écarts site / wiki (non appliqués)', report.rayonNoir);
  section('Fiches modifiées', [...report.changes].map(([t, w]) => `${t} : ${w.map(c => `${c.field} ${c.detail}`).join(', ')}`));
  const text = md.join('\n');
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, text + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');

  // ---- Message de commit ----
  if (COMMIT_MESSAGE && changed) {
    const lines = [`Synchro wiki : ${added.length} ajoutée(s), ${modified.length} modifiée(s)`, ''];
    if (added.length) lines.push('Ajoutées :', ...added.map(f => `- ${f['titre']}`), '');
    if (modified.length) lines.push('Modifiées :', ...[...report.changes].map(([t, w]) => `- ${t} (${[...new Set(w.map(c => c.field))].join(', ')})`), '');
    lines.push(`Source : ${WIKI} (CC BY-SA 3.0)`);
    fs.writeFileSync(COMMIT_MESSAGE, lines.join('\n') + '\n');
  }

  say(`\n${withPage} fiche(s) rapprochée(s), ${added.length} ajoutée(s), ${modified.length} modifiée(s), ${report.conflicts.length + report.noMatch.length + proposals.length + uncategorized.length + noSpeciality.length} à vérifier — rapport : ${path.relative(process.cwd(), REPORT)}${DRY ? ' (simulation)' : ''}`);
  if (!changed) say('Aucun changement de données.');
}

main().catch(error => { console.error(`Échec de la synchro : ${error.message}`); process.exit(1); });
