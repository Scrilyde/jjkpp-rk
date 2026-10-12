// Correspondance fiche wiki ↔ schéma JSON du site, rapprochement et normalisations.
import { cleanWikitext, isBlank } from './wiki.mjs';

// Valeur courante d'un paramètre : la version rééquilibrée (« Post-adjust ») prime sur l'originale.
export function pick(w, key) {
  for (const k of [`Post-adjust ${key} (V2)`, `Post-adjust ${key}`, key]) if (!isBlank(w[k])) return w[k];
  return null;
}
const text = (w, key) => { const v = pick(w, key); return v == null ? null : cleanWikitext(v); };
const raw = (w, key) => isBlank(w[key]) ? null : cleanWikitext(w[key]);

// « 41,113 » → 41113 ; « 40->70(Post-Adjust) » → 70 ; sinon null.
export function parseStat(value) {
  if (isBlank(value)) return null;
  let s = cleanWikitext(value).replace(/\s+/g, '');
  if (s.includes('->')) s = s.split('->').pop();
  s = s.replace(/\(.*?\)/g, '').replace(/,/g, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

// Coût d'énergie : entier, ou premier entier d'une valeur annotée (signalée par `note`).
export function parseCost(value) {
  if (isBlank(value)) return { value: null };
  const s = cleanWikitext(value);
  if (/^\d+$/.test(s)) return { value: Number(s) };
  const m = /^(\d+)/.exec(s);
  return { value: m ? Number(m[1]) : null, note: s.replace(/\n/g, ' ') };
}

// Date J-M-AAAA (séparateurs - / .) → JJ-MM-AAAA ; null si illisible.
export function normalizeDate(value) {
  const m = /^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\s*$/.exec(String(value ?? ''));
  if (!m || +m[1] < 1 || +m[1] > 31 || +m[2] < 1 || +m[2] > 12) return null;
  return `${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}-${m[3]}`;
}

export const STATS = [
  ['pv', 'HP'], ['atq', 'Attack'], ['jujutsu', 'Jujutsu'],
  ['énergie_occulte_initiale', 'Initial Cursed Energy'], ['énergie_occulte_max', 'Max Cursed Energy'], ['jauge_spéciale', 'Special Gauge'],
];
export const blackFlash = w => !isBlank(w['Post-adjustment Black Flash']) ? cleanWikitext(w['Post-adjustment Black Flash']) : (isBlank(w['Black Flash']) ? 'N/A' : cleanWikitext(w['Black Flash']));

// Bloc avec forme modifiée (paramètres « Changed … ») ; les clés vides sont omises.
function block(w, { nom, img, cost, effect, changedEffect, changedImg, changedCost, indice }) {
  const b = {};
  if (indice != null) b['indice'] = indice;
  b['nom'] = raw(w, nom);
  b['clé_image'] = raw(w, img);
  const notes = [];
  if (cost) { const c = parseCost(pick(w, cost)); b['coût_énergie'] = c.value; if (c.note) notes.push(`${cost} = « ${c.note} »`); }
  b['effet'] = text(w, effect) ?? '';
  b['effet_niv10'] = text(w, `${effect} 10`) ?? '';
  const ce = text(w, changedEffect), ce10 = text(w, `${changedEffect} 10`);
  if (ce || ce10) {
    b['modifié_effet'] = ce ?? '';
    b['modifié_effet_niv10'] = ce10 ?? '';
    if (raw(w, changedImg)) b['modifié_clé_image'] = raw(w, changedImg);
    if (changedCost) { const c = parseCost(pick(w, changedCost)); if (c.value != null) b['modifié_coût_énergie'] = c.value; if (c.note) notes.push(`${changedCost} = « ${c.note} »`); }
  }
  return { b, notes };
}

// Kit complet d'une fiche wiki, en anglais, dans la structure du site.
export function wikiKit(w) {
  const notes = [];
  const take = r => { notes.push(...r.notes); return r.b; };
  const kit = {};
  kit['attaque_normale'] = take(block(w, { nom: 'Normal Attack', img: 'NormalAttackImg', effect: 'Normal Attack Effect', changedEffect: 'Changed Normal Attack Effect', changedImg: 'ChangedNormalAttackImg' }));
  kit['compétences'] = [1, 2].filter(i => !isBlank(w[`Skill ${i}`]) || pick(w, `Skill ${i} Effect`)).map(i => take(block(w, {
    indice: i, nom: `Skill ${i}`, img: `Skill${i}Img`, cost: `Energy Cost S${i}`, effect: `Skill ${i} Effect`,
    changedEffect: `Changed Skill ${i} Effect`, changedImg: `ChangedSkill${i}Img`, changedCost: `Changed Energy Cost S${i}`,
  })));
  kit['ultime'] = take(block(w, { nom: 'Ult', img: 'UltImg', effect: 'Ult Effect', changedEffect: 'Changed Ult Effect', changedImg: 'ChangedUltImg' }));
  kit['compétences_auto'] = [];
  for (let i = 1; i <= 6; i++) {
    if (isBlank(w[`Auto Skill ${i} Name`])) continue;
    kit['compétences_auto'].push({ 'indice': kit['compétences_auto'].length + 1, 'nom': raw(w, `Auto Skill ${i} Name`), 'clé_image': raw(w, `Auto Skill ${i} Img`), 'effet': text(w, `Auto Skill ${i} Effect`) ?? '' });
  }
  kit['ultime_coopérative'] = { 'effet': text(w, 'Combo Ult Effect') ?? '', 'effet_renforcé': text(w, 'Buffed Combo Ult Effect') ?? '' };
  return { kit, notes };
}

// Paramètres ignorés mais signalés : formes SP et « Second Changed ».
export function ignoredParams(w) {
  const groups = new Set();
  for (const [k, v] of Object.entries(w)) {
    if (isBlank(v)) continue;
    if (/^(?:Post-adjust\s+)?SP(?:\s|[A-Z])/.test(k)) groups.add('SP*');
    if (/^(?:Post-adjust\s+)?Second\s?Changed/i.test(k)) groups.add('Second Changed*');
  }
  return [...groups];
}

// Paires (texte EN, texte FR) d'une fiche existante et de sa fiche wiki, pour dériver le glossaire.
export function textPairs(fiche, w) {
  const { kit } = wikiKit(w);
  const pairs = [];
  const add = (en, fr, where) => { if (en && fr && typeof fr === 'string') pairs.push({ en, fr, where }); };
  const fields = ['effet', 'effet_niv10', 'modifié_effet', 'modifié_effet_niv10'];
  const both = (a, b, where) => { if (a && b) fields.forEach(f => add(a[f], b[f], `${where}.${f}`)); };
  both(kit['attaque_normale'], fiche['attaque_normale'], 'attaque_normale');
  kit['compétences'].forEach((c, i) => both(c, (fiche['compétences'] || []).find(x => x['indice'] === c['indice']) || (fiche['compétences'] || [])[i], `compétences[${i}]`));
  both(kit['ultime'], fiche['ultime'], 'ultime');
  const autos = fiche['compétences_auto'] || [];
  kit['compétences_auto'].forEach((a, i) => {
    const fr = autos.find(x => x['clé_image'] && x['clé_image'] === a['clé_image']) || (autos.length === kit['compétences_auto'].length ? autos[i] : null);
    if (fr) { add(a['effet'], fr['effet'], `compétences_auto[${i}].effet`); if (a['nom'] && fr['nom']) pairs.push({ en: a['nom'], fr: fr['nom'], where: 'nom_auto' }); }
  });
  const co = fiche['ultime_coopérative'] || {};
  add(kit['ultime_coopérative']['effet'], co['effet'], 'ultime_coopérative.effet');
  add(kit['ultime_coopérative']['effet_renforcé'], co['effet_renforcé'], 'ultime_coopérative.effet_renforcé');
  return pairs;
}

// Titre de page à partir d'une URL du wiki (champ historique url_wiki).
// Les URL existantes ne sont pas encodées : « ? » fait partie du titre sauf s'il introduit « clé=valeur ».
export function titleFromUrl(url) {
  const m = /\/wiki\/(.+?)(?:\?[\w-]+=[^#]*)?(?:#.*)?$/.exec(url || '');
  if (!m) return null;
  let title = m[1];
  try { title = decodeURIComponent(title); } catch {}
  return title.replace(/_/g, ' ');
}

// Rapprochement fiche ↔ page wiki.
// Ordre : page_wiki (fait foi) > url_wiki > clé_icône = UnitN > clé_image = Card Art (unique des deux côtés).
// `resolved` : titre demandé → { title, exists } ; `listEntries` : [{ title, unit }] ; `wikiParams` : titre → paramètres.
export function matchFiches(fiches, { resolved, listEntries, wikiParams }) {
  const canon = t => resolved[t]?.title ?? t;
  const exists = t => resolved[t]?.exists ?? Boolean(wikiParams[t]);
  const unitTitles = new Map();
  for (const e of listEntries) if (e.unit) unitTitles.set(e.unit, new Set([...(unitTitles.get(e.unit) || []), canon(e.title)]));
  const titleUnits = new Map();
  for (const e of listEntries) if (e.unit) titleUnits.set(canon(e.title), new Set([...(titleUnits.get(canon(e.title)) || []), e.unit]));
  const artPages = new Map();
  for (const [t, w] of Object.entries(wikiParams)) { const a = w['Card Art']; if (a) artPages.set(a, [...(artPages.get(a) || []), t]); }
  const ourArts = new Map();
  for (const f of fiches) if (f['clé_image']) ourArts.set(f['clé_image'], (ourArts.get(f['clé_image']) || 0) + 1);

  const results = fiches.map(f => {
    const found = [];
    if (f['page_wiki']) found.push({ method: 'page_wiki', title: canon(f['page_wiki']), asked: f['page_wiki'] });
    if (f['url_wiki'] && titleFromUrl(f['url_wiki'])) found.push({ method: 'url_wiki', title: canon(titleFromUrl(f['url_wiki'])), asked: titleFromUrl(f['url_wiki']) });
    const ut = unitTitles.get(f['clé_icône']);
    if (ut) found.push(ut.size === 1 ? { method: 'clé_icône', title: [...ut][0] } : { method: 'clé_icône', ambiguous: [...ut] });
    const art = f['clé_image'], ap = art && artPages.get(art);
    if (ap) found.push(ap.length === 1 && ourArts.get(art) === 1 ? { method: 'clé_image', title: ap[0] } : { method: 'clé_image', ambiguous: ap.length > 1 ? ap : [`${art} présente sur ${ourArts.get(art)} fiches du site`] });
    const r = { fiche: f, found, title: null, exists: false, unit: null, method: null, conflict: null, warning: null };
    const usable = found.filter(x => x.title);
    const ambiguous = found.filter(x => x.ambiguous);
    if (found[0]?.method === 'page_wiki') {
      r.title = found[0].title; r.method = 'page_wiki';
      const other = usable.filter(x => x.title !== r.title);
      if (other.length) r.warning = `page_wiki conservé malgré ${other.map(x => `${x.method} → « ${x.title} »`).join(', ')}`;
    } else if (new Set(usable.map(x => x.title)).size > 1) {
      r.conflict = `méthodes en désaccord : ${usable.map(x => `${x.method} → « ${x.title} »`).join(' ; ')}`;
    } else if (usable.length) {
      r.title = usable[0].title; r.method = usable.map(x => x.method).join(' + ');
    } else if (ambiguous.length) {
      r.conflict = `correspondance ambiguë : ${ambiguous.map(x => `${x.method} → ${x.ambiguous.map(t => `« ${t} »`).join(', ')}`).join(' ; ')}`;
    }
    if (r.title) {
      r.exists = exists(r.title) && Boolean(wikiParams[r.title]);
      const units = usable.some(x => x.method === 'clé_icône') ? new Set([f['clé_icône']]) : titleUnits.get(r.title);
      r.unit = units?.size === 1 ? [...units][0] : null;
    }
    return r;
  });
  // une page ne peut correspondre qu'à une seule fiche
  const byTitle = new Map();
  for (const r of results) if (r.title) byTitle.set(r.title, [...(byTitle.get(r.title) || []), r]);
  for (const [t, rs] of byTitle) if (rs.length > 1) for (const r of rs) {
    r.conflict = `« ${t} » est aussi rapprochée de ${rs.filter(x => x !== r).map(x => `« ${x.fiche['titre']} »`).join(', ')}`;
    r.title = null; r.exists = false; r.unit = null;
  }
  return results;
}
