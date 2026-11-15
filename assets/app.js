/* JJKPP [RK] — interface « Ofuda ». Données : data/characters.json et data/categories.json (format inchangé).
   Routes : #/?filtres… (liste) et #/fiche/<clé_image>?niv=10&version=… (fiche partageable). */
(function () {
  'use strict';

  const ELEMENTS = ['Jaune', 'Vert', 'Bleu', 'Rouge'];
  const KANJI = { Jaune: '行', Vert: '夜', Bleu: '影', Rouge: '幻' };
  const RARITIES = ['SSR', 'SR', 'R'];
  const RANK = { SSR: 3, SR: 2, R: 1 };
  const SPECIALITIES = ['Taijutsu', 'Jujutsu', 'Hybride'];
  const GROUPS = ['élément', 'rareté', 'catégorie', 'spécialité'];
  const PARAM = { 'élément': 'element', 'rareté': 'rarete', 'catégorie': 'categorie', 'spécialité': 'specialite' };
  const GROUP_LABEL = { 'élément': 'Élément', 'rareté': 'Rareté', 'catégorie': 'Catégorie', 'spécialité': 'Spécialité' };
  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  // Ligne restée en anglais (même repérage que l'ancienne page).
  const EN = /\b(the|to|of|and|when|with|enemy|enemies|applies|deals|increases|decreases|recovers|damage|turns?|while|after|self|state|status)\b/i;
  const DESKTOP = window.matchMedia('(min-width: 960px)');
  const LIST_TITLE = document.title;

  const view = document.getElementById('view');
  const live = document.getElementById('live');

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nf = v => (v == null || v === '' ? '—' : Number(v).toLocaleString('fr-FR'));
  const norm = s => String(s || '').toLocaleLowerCase('fr-FR').normalize('NFD').replace(/[̀-ͯ]/g, '');
  const fiches = n => n + ' ' + (isMemory() ? (n > 1 ? 'souvenirs' : 'souvenir') : (n > 1 ? 'fiches' : 'fiche'));
  const pct = (v, max) => Math.max(3, Math.round((v || 0) / max * 100)) + '%';
  const marks = (r, cls = '') => `<span class="marks r${RANK[r] || 1}${cls ? ' ' + cls : ''}" aria-hidden="true"><i></i><i></i><i></i></span>`;
  const ficheHref = r => '#/fiche/' + encodeURIComponent(r.id);

  // Animation réencodée à partir de trames complètes pour éviter les artefacts.
  // La correction reste indépendante des synchronisations du wiki.
  const ART_OVERRIDES = { DazzledByDistantDay: 'assets/images/dazzled-by-the-distant-day.webp' };

  const rawCollections = { personnages: [], souvenirs: [] };
  const collectionRequests = new Map();
  let categoriesRequest, routeVersion = 0, searchTimer;

  const CARD_SIZES = '(max-width: 679px) calc(100vw - 32px), (max-width: 959px) calc(50vw - 24px), (max-width: 1069px) calc(100vw - 352px), (max-width: 1437px) calc(50vw - 185px), (max-width: 1805px) calc(33.333vw - 129.334px), calc(25vw - 101.5px)';

  // Le navigateur choisit une seule variante selon la place et la densité de l’écran.
  function imageAttrs(source, width, sizes = '') {
    if (!source) return 'src=""';
    if (source === ART_OVERRIDES.DazzledByDistantDay && sizes) {
      return `src="assets/images/dazzled-by-the-distant-day-480.webp" srcset="assets/images/dazzled-by-the-distant-day-480.webp 480w, ${esc(source)} 847w" sizes="${esc(sizes)}" data-original-src="${esc(source)}"`;
    }
    // Les conversions d’animations à trames partielles peuvent produire des bandes
    // sans déclencher d’erreur réseau. Servir ces formats intacts, dès le départ.
    if (/\.(?:gif|webp|avif|apng)(?:[/?#]|$)/i.test(source)) return `src="${esc(source)}"`;
    if (!/^https:\/\/static\.wikia\.nocookie\.net\/jjk-phantom-parade\//.test(source)) return `src="${esc(source)}"`;
    const url = w => '/.netlify/images?url=' + encodeURIComponent(source) + '&w=' + w + '&q=' + (width > 192 ? 65 : 75);
    const widths = sizes ? [320, 480, 640, 960] : [width / 2, width];
    const srcset = widths.map(w => esc(url(w)) + ' ' + w + 'w').join(', ');
    return `src="${esc(url(sizes ? 480 : width))}" srcset="${srcset}" sizes="${esc(sizes || (width / 2 + 'px'))}" data-original-src="${esc(source)}"`;
  }

  const cardLoading = index => index === 0 ? 'loading="eager" fetchpriority="high"' : index < 3 ? 'loading="eager"' : 'loading="lazy"';

  let DATA = [], BY_ID = new Map(), CATEGORIES = [], maxPV = 1, maxST = 1;
  const state = { collection: 'personnages', q: '', 'élément': [], 'rareté': [], 'catégorie': [], 'spécialité': [], vue: 'cartes', tri: '', ordre: 'desc' };
  let current = null, listScroll = 0, cameFromList = false, lastListHash = '#/', sheetOpen = false, lastFocus = null;

  /* ---------------- Données ---------------- */

  function prepare(list, categoryRoles, memories) {
    CATEGORIES = Object.keys(categoryRoles);
    const roleCats = {};
    for (const [cat, roles] of Object.entries(categoryRoles)) for (const role of roles) (roleCats[role] = roleCats[role] || []).push(cat);
    const used = new Set();
    DATA = [...list, ...memories].map((d, i) => {
      const memory = !!d.bonus;
      const s = d['statistiques'] || {};
      // identifiant stable pour l'URL : clé d'image du jeu (unique), sinon clé d'icône
      let id = String(d.id || d['clé_image'] || d['clé_icône'] || 'fiche-' + (i + 1));
      while (used.has(id)) id += '-' + (i + 1);
      used.add(id);
      const epi = d['épithète'] || (/^\((.*)\)/.exec(d['titre'] || '') || [])[1] || '';
      const name = d['nom'] || d['titre'] || '';
      const cats = Array.isArray(d['catégories']) && d['catégories'].length ? d['catégories'] : (roleCats[d['rôle']] || []);
      return {
        d, id, i, memory, art: ART_OVERRIDES[d['clé_image']] || d.url_image || d.url_icône, el: d['élément'] || '', k: KANJI[d['élément']] || '', epi, name, rar: d['rareté'] || '', role: d['rôle'] || '', spe: d['spécialité'] || '', cats,
        pv: memory ? bonusNumber(d.bonus.pv) : s['pv'], tai: memory ? bonusNumber(d.bonus.tai) : s['atq'], juj: memory ? bonusNumber(d.bonus.juj) : s['jujutsu'], eoi: s['énergie_occulte_initiale'], eom: s['énergie_occulte_max'], js: s['jauge_spéciale'],
        rn: s['rayon_noir'] === 'Oui', icon: d['url_icône'] || '', search: norm(epi + ' ' + name + ' ' + (d['titre'] || '')),
      };
    });
    maxPV = Math.max(1, ...DATA.filter(r => !r.memory).map(r => r.pv || 0));
    maxST = Math.max(1, ...DATA.filter(r => !r.memory).map(r => Math.max(r.tai || 0, r.juj || 0)));
    BY_ID = new Map(DATA.map(r => [r.id, r]));
  }

  /* ---------------- Filtres : OU dans un groupe, ET entre groupes ---------------- */

  const isMemory = () => state.collection === 'souvenirs';
  const collection = () => DATA.filter(r => r.memory === isMemory());
  const groups = () => isMemory() ? ['rareté'] : GROUPS;
  const bonusNumber = v => { const m = /([\d]+(?:[.,]\d+)?)\s*%/.exec(String(v || '')); return m ? Number(m[1].replace(',', '.')) : -1; };
  function bonusHTML(v) {
    const text = String(v || '—').replace(/^(?:HP|PV|Taijutsu|Jujutsu)\s*:\s*/i, '').replace(/\s*\((?:Level|Lv\.?|Niv\.?)\s*(\d+)\)/gi, ' (Niv. $1)');
    const m = /\s*(\(Niv\. \d+\))/.exec(text);
    return `<span class="bonus-value">${esc(text.replace(/\s*\(Niv\. \d+\)/, '').replaceAll('.', ','))}<small class="bonus-level">${m ? esc(m[1]) : '&nbsp;'}</small></span>`;
  }
  const dateKey = r => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(r.d.date_de_sortie || ''); return m ? Number(m[3]+m[2]+m[1]) : 0; };
  const has = (r, g, v) => (g === 'élément' ? r.el === v : g === 'rareté' ? r.rar === v : g === 'spécialité' ? r.spe === v : r.cats.includes(v));
  function matches(r, st, skip) {
    const q = norm(st.q.trim());
    if (skip !== 'q' && q && !r.search.includes(q)) return false;
    return groups().every(g => g === skip || !st[g].length || st[g].some(v => has(r, g, v)));
  }
  const filtered = (st = state) => collection().filter(r => matches(r, st));
  const active = (st = state) => groups().flatMap(g => st[g].map(v => ({ g, v })));
  const options = g => (g === 'élément' ? ELEMENTS : g === 'rareté' ? RARITIES : g === 'catégorie' ? CATEGORIES : SPECIALITIES);

  const SORTS = {
    personnage: r => norm(r.name + ' ' + r.epi),
    rarete: r => RANK[r.rar] || 0,
    pv: r => r.pv ?? -1, tai: r => r.tai ?? -1, juj: r => r.juj ?? -1,
  };
  function sorted(list) {
    const key = SORTS[state.tri];
    if (!key) return isMemory() ? list.slice().sort((a,b) => dateKey(b)-dateKey(a) || a.i-b.i) : list;
    const dir = state.ordre === 'asc' ? 1 : -1;
    return list.slice().sort((a, b) => {
      const x = key(a), y = key(b);
      return (typeof x === 'string' ? x.localeCompare(y, 'fr') : x - y) * dir || a.i - b.i;
    });
  }
  const tableMode = () => state.vue === 'tableau';
  const visibleOrder = () => sorted(filtered());

  /* ---------------- URL ---------------- */

  function listHash() {
    const p = new URLSearchParams();
    if (isMemory()) p.set('collection', 'souvenirs');
    if (state.q.trim()) p.set('q', state.q.trim());
    for (const g of GROUPS) if (state[g].length) p.set(PARAM[g], state[g].join(','));
    if (state.vue === 'tableau') p.set('vue', 'tableau');
    if (state.tri) p.set('tri', state.tri + '-' + state.ordre);
    const s = p.toString();
    return '#/' + (s ? '?' + s : '');
  }
  function readListParams(qs) {
    const p = new URLSearchParams(qs);
    state.collection = p.get('collection') === 'souvenirs' ? 'souvenirs' : 'personnages';
    state.q = p.get('q') || '';
    for (const g of GROUPS) state[g] = (p.get(PARAM[g]) || '').split(',').filter(v => options(g).includes(v));
    if (isMemory()) GROUPS.filter(g => g !== 'rareté').forEach(g => { state[g] = []; });
    state.vue = p.get('vue') === 'tableau' ? 'tableau' : 'cartes';
    const t = /^(personnage|rarete|pv|tai|juj)-(asc|desc)$/.exec(p.get('tri') || '');
    state.tri = t ? t[1] : '';
    state.ordre = t ? t[2] : 'desc';
  }
  function parseRoute() {
    const h = location.hash || '#/';
    const f = /^#\/fiche\/([^?]+)(?:\?(.*))?$/.exec(h);
    if (f) { let id = f[1]; try { id = decodeURIComponent(id); } catch (e) { /* identifiant brut */ } return { name: 'fiche', id, qs: f[2] || '' }; }
    const l = /^#\/?(?:\?(.*))?$/.exec(h);
    return { name: 'list', qs: l ? l[1] || '' : '' };
  }
  function commitList() {
    lastListHash = listHash();
    history.replaceState(null, '', lastListHash);
    updateList();
  }

  /* ---------------- Thème ---------------- */

  function paintTheme() {
    const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    document.querySelectorAll('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeSet === t)));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = t === 'light' ? '#fdf7f2' : '#0e121a';
  }
  function setTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('jjkpp-theme', t); } catch (e) { /* stockage indisponible : thème non mémorisé */ }
    paintTheme();
  }

  /* ---------------- Liste ---------------- */


  function memorySortHTML() {
    return `<div class="fgroup" role="group" aria-label="Spécialité"><div class="fgroup-head"><span>Spécialité</span></div><div class="opt-grid">${[['pv','PV'],['tai','Taijutsu'],['juj','Jujutsu']].map(([k,v]) => `<button type="button" data-memory-sort="${k}" aria-pressed="${state.tri === k}">${v}</button>`).join('')}</div><span class="sort-hint">Du pourcentage le plus élevé au plus faible</span></div>`;
  }
  function memoryStats(r, compact = false) {
    return [['pv','PV'],['tai','Taijutsu'],['juj','Jujutsu']].map(([k,v]) => compact
      ? `<div class="stat" data-s="${k}"><div class="stat-top"><span class="lab"><span class="lab-short">${{pv: 'PV', tai: 'TAI', juj: 'JUJ'}[k]}</span><span class="lab-long">${v.toUpperCase()}</span></span>${bonusHTML(r.d.bonus[k]).replace('class="bonus-value"', 'class="bonus-value v"')}</div></div>`
      : `<div class="memory-stat" data-s="${k}"><span class="lab">${v}</span>${bonusHTML(r.d.bonus[k])}</div>`).join('');
  }
  function memoryCardHTML(r, index = 0) {
    return `<a class="card memory-card illustrated" href="${ficheHref(r)}"><div class="card-surface"><img class="card-art" referrerpolicy="no-referrer" ${imageAttrs(r.art, 640, CARD_SIZES)} alt="" ${cardLoading(index)} decoding="async"><div class="card-body"><div class="card-head"><div class="card-id"><div class="meta">${marks(r.rar)}<span class="rar">${esc(r.rar)}</span><span>Souvenir</span></div><div class="name" title="${esc(r.name)}">${esc(r.name)}</div></div></div><div class="stats memory-stats">${memoryStats(r, true)}</div></div></div></a>`;
  }
  function memoryTableHTML(list) {
    const th = (k,v) => `<th scope="col"${state.tri === k ? ` aria-sort="${state.ordre === 'asc' ? 'ascending':'descending'}"` : ''}><button type="button" data-sort="${k}">${v}${state.tri === k ? (state.ordre === 'asc' ? ' ↑':' ↓') : ' ↕'}</button></th>`;
    return `<div class="table-wrap"><div class="tpanel"><table class="ftable memory-table"><caption class="visually-hidden">Souvenirs, cliquez un en-tête pour trier</caption><thead><tr>${th('personnage','Souvenir')}${th('rarete','Rareté')}${th('pv','PV')}${th('tai','Taijutsu')}${th('juj','Jujutsu')}</tr></thead><tbody>${list.map(r => `<tr data-href="${ficheHref(r)}"><td><div class="tname"><img class="icon" referrerpolicy="no-referrer" ${imageAttrs(r.icon || r.art, 80)} alt="" loading="lazy" width="40" height="40"><a href="${ficheHref(r)}">${esc(r.name)}</a></div></td><td>${esc(r.rar)}</td>${['pv','tai','juj'].map(k => `<td class="tnum">${bonusHTML(r.d.bonus[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
  }
  function renderMemory(r) {
    const {prev,next} = neighbours(r);
    const nav = (x,label) => x ? `<a href="${ficheHref(x)}" data-nav>${label}</a>` : '';
    document.title = r.name + ' · Souvenir · JJKPP [RK]';
    view.innerHTML = `<nav class="memory-nav"><a class="btn-back" href="${esc(lastListHash)}" data-back>← Souvenirs</a><div class="pn">${nav(prev,'‹ Précédent')}${nav(next,'Suivant ›')}</div></nav><div class="fiche memory-fiche"><div class="fiche-side"><section class="idcard"><div class="idcard-body"><img class="memory-art" referrerpolicy="no-referrer" ${imageAttrs(r.art, 640, '(min-width: 960px) 340px, calc(100vw - 64px)')} alt="${esc(r.name)}" fetchpriority="high" decoding="async"><div class="meta">${marks(r.rar)}<span>${esc(r.rar)} · Souvenir</span></div><h1 tabindex="-1">${esc(r.name)}</h1><dl class="info"><dt>Sortie</dt><dd>${esc(dateFr(r.d.date_de_sortie))}</dd></dl><div class="memory-stats">${memoryStats(r)}</div></div></section></div><section class="kit" aria-label="Effets du souvenir"><div class="kit-head"><h2>Effets du souvenir</h2></div>${r.d.effets.map(e => `<section class="skill"><div class="skill-meta"><div class="skill-type">${esc(e.nom)}</div></div><div class="skill-main"><div class="skill-top"><h3>${esc(e.nom)}</h3></div>${e.déblocage ? `<p class="sort-hint">${esc(e.déblocage)}</p>`:''}${e.recharge ? `<p class="sort-hint">Recharge : ${esc(e.recharge)} tours</p>`:''}<div class="lines">${parseLines(e.effet).map(lineHTML).join('')}</div></div></section>`).join('')}</section></div>`;
    view.dataset.fiche = r.id;
    window.scrollTo(0,0); view.querySelector('h1').focus({preventScroll:true});
  }

  function cardHTML(r, index = 0) {
    if (r.memory) return memoryCardHTML(r, index);
    const td = (r.tai || 0) >= (r.juj || 0);
    const stat = (short, long, v, max, strong, k) => `<div class="stat" data-s="${k}"><div class="stat-top"><span class="lab"><span class="lab-short">${short}</span><span class="lab-long">${long}</span></span><span class="v${strong ? '' : ' weak'}">${nf(v)}</span></div><div class="bar"><i${strong ? '' : ' class="weak"'} style="width:${pct(v, max)}"></i></div></div>`;
    return `<a class="card illustrated" data-el="${esc(r.el)}" href="${ficheHref(r)}" aria-label="${esc(r.d['titre'] || r.name)} — ${esc(r.rar)}, ${esc(r.el)}">
<div class="card-surface"><img class="card-art" referrerpolicy="no-referrer" ${imageAttrs(r.art, 640, CARD_SIZES)} alt="" ${cardLoading(index)} decoding="async"><div class="strip" aria-hidden="true"><span class="k">${r.k}</span><span class="el">${esc(r.el)}</span></div>
<div class="card-body">
<div class="card-head">
<div class="card-id"><div class="meta">${marks(r.rar)}<span class="rar">${esc(r.rar)}</span><span class="role">${esc(r.role || '—')}<span class="m-only"> · ${esc(r.spe || '—')}</span></span></div>
<div class="epi">(${esc(r.epi)})</div><div class="name">${esc(r.name)}</div></div>
${r.rn ? '<span class="stamp-rn" title="Rayon Noir"><span>黒</span><span>閃</span></span>' : ''}</div>
<div class="stats">${stat('PV', 'PV', r.pv, maxPV, true, 'pv')}${stat('TAI', 'TAIJUTSU', r.tai, maxST, td, 'tai')}${stat('JUJ', 'JUJUTSU', r.juj, maxST, !td, 'juj')}</div>
<div class="card-foot"><span>EO <span class="num">${nf(r.eoi)}</span> / <span class="num">${nf(r.eom)}</span></span><span>Jauge<span class="m-only"> sp.</span> <span class="num">${nf(r.js)}</span></span>${r.rn ? '<span class="end rn m-only">Rayon Noir</span>' : ''}<span class="end d-only">${esc(r.spe)}</span></div>
</div></div></a>`;
  }

  function tableHTML(list) {
    if (isMemory()) return memoryTableHTML(list);
    const th = (key, label, cls = '') => {
      if (!key) return `<th scope="col"${cls ? ` class="${cls}"` : ''}>${label}</th>`;
      const on = state.tri === key, arrow = on ? (state.ordre === 'asc' ? '↑' : '↓') : '↕';
      return `<th scope="col"${cls ? ` class="${cls}"` : ''}${on ? ` aria-sort="${state.ordre === 'asc' ? 'ascending' : 'descending'}"` : ''}><button type="button" data-sort="${key}">${label} <span class="arr" aria-hidden="true">${arrow}</span></button></th>`;
    };
    // infos secondaires regroupées dans une seule colonne à écarts fixes : les statistiques les recouvrent quand la place manque
    const sortBtn = (key, label) => {
      const on = state.tri === key, arrow = on ? (state.ordre === 'asc' ? '↑' : '↓') : '↕';
      return `<button type="button" data-sort="${key}">${label} <span class="arr" aria-hidden="true">${arrow}</span></button>`;
    };
    const num = (v, max, strong, k) => `<td class="tnum" data-s="${k}"><div class="v${strong ? '' : ' weak'}">${nf(v)}</div><div class="bar"><i${strong ? '' : ' class="weak"'} style="width:${pct(v, max)}"></i></div></td>`;
    const rows = list.map(r => {
      const td = (r.tai || 0) >= (r.juj || 0);
      return `<tr data-href="${ficheHref(r)}" data-el="${esc(r.el)}"><td><div class="tname"><img class="icon" ${imageAttrs(r.icon, 80)} alt="" loading="lazy" decoding="async" width="40" height="40"><div class="tname-id"><div class="tname-row"><a href="${ficheHref(r)}" title="(${esc(r.epi)})">${esc(r.name)}</a>${r.rn ? '<span class="stamp-rn row" role="img" aria-label="Rayon Noir" title="Rayon Noir"><span>黒</span><span>閃</span></span>' : ''}</div><div class="epi">(${esc(r.epi)})</div></div></div></td>
<td class="sec"><div class="fade"><span class="c-el"><span class="tdot" aria-hidden="true"></span>${esc(r.el)}</span><span class="c-rar">${esc(r.rar)}</span><span class="c-role">${esc(r.role || '—')}</span><span class="c-spe">${esc(r.spe || '—')}</span></div></td>
${num(r.pv, maxPV, true, 'pv')}${num(r.tai, maxST, td, 'tai')}${num(r.juj, maxST, !td, 'juj')}</tr>`;
    }).join('');
    return `<div class="table-wrap"><div class="tpanel"><table class="ftable"><caption class="visually-hidden">Fiches, cliquez un en-tête pour trier</caption>
<thead><tr>${th('personnage', 'Personnage')}<th scope="col" class="sec"${state.tri === 'rarete' ? ` aria-sort="${state.ordre === 'asc' ? 'ascending' : 'descending'}"` : ''}><div class="fade"><span class="c-el">Élément</span><span class="c-rar">${sortBtn('rarete', 'Rareté')}</span><span class="c-role">Rôle</span><span class="c-spe">Spécialité</span></div></th>${th('pv', 'PV')}${th('tai', '<span class="thl">Taijutsu</span><span class="ths">Tai</span>')}${th('juj', '<span class="thl">Jujutsu</span><span class="ths">Juj</span>')}</tr></thead>
<tbody>${rows}</tbody></table></div></div>`;
  }

  function emptyHTML() {
    const q = state.q.trim(), act = active();
    let msg = q ? `Recherche « ${q} »` : '';
    if (act.length) msg += (msg ? ' avec ' : '') + `${act.length} filtre${act.length > 1 ? 's' : ''} actif${act.length > 1 ? 's' : ''} (${act.map(a => a.v).join(', ')})`;
    msg += '. Essayez d’élargir :';
    const sugg = [];
    if (q) { const n = DATA.filter(r => matches(r, state, 'q')).length; if (n) sugg.push({ action: 'q', lab: `Effacer la recherche « ${q} »`, n }); }
    for (const { g, v } of act) {
      const st2 = Object.assign({}, state, { [g]: state[g].filter(x => x !== v) });
      const n = filtered(st2).length;
      if (n) sugg.push({ action: g + '|' + v, lab: `Retirer « ${g === 'élément' ? KANJI[v] + ' ' + v : v} »`, n });
    }
    return `<div class="empty"><div class="stamp-empty k" aria-hidden="true">無</div><h2>Aucune fiche ne correspond.</h2><p>${esc(msg)}</p>
<div class="sugg">${sugg.map(s => `<button type="button" data-remove="${esc(s.action)}"><span>${esc(s.lab)}</span><span class="num">${fiches(s.n)} →</span></button>`).join('')}</div>
<button type="button" class="btn-outline" data-reset>Tout réinitialiser · ${fiches(collection().length)}</button></div>`;
  }

  function chipsHTML() {
    const out = [];
    if (state.q.trim()) out.push(`<button type="button" class="chip" data-remove="q" aria-label="Retirer la recherche « ${esc(state.q.trim())} »">« ${esc(state.q.trim())} »<span class="x" aria-hidden="true">×</span></button>`);
    for (const { g, v } of active()) out.push(`<button type="button" class="chip"${g === 'élément' ? ` data-el="${esc(v)}"` : ''} data-remove="${esc(g + '|' + v)}" aria-label="Retirer le filtre ${esc(GROUP_LABEL[g])} : ${esc(v)}">${g === 'élément' ? `<span class="k">${KANJI[v]}</span>` : ''}${esc(v)}<span class="x" aria-hidden="true">×</span></button>`);
    return out.join('');
  }

  function groupHTML(g) {
    const head = `<div class="fgroup-head"><span>${GROUP_LABEL[g]}</span><span class="sel" data-sel="${g}"></span></div>`;
    if (g === 'élément') {
      return `<div class="fgroup" role="group" aria-label="${GROUP_LABEL[g]}">${head}<div class="el-grid">${ELEMENTS.map(e =>
        `<button type="button" data-el="${e}" data-g="${g}" data-v="${e}" aria-pressed="false"><span class="k">${KANJI[e]}</span><span class="lab">${e}</span></button>`).join('')}</div></div>`;
    }
    return `<div class="fgroup" role="group" aria-label="${GROUP_LABEL[g]}">${head}<div class="opt-grid">${options(g).map(v =>
      `<button type="button" data-g="${g}" data-v="${esc(v)}" aria-pressed="false">${g === 'rareté' ? marks(v) : ''}<span class="lab" data-t="${esc(v)}">${esc(v)}</span></button>`).join('')}</div></div>`;
  }

  function renderListSkeleton() {
    view.dataset.collection = state.collection;
    view.innerHTML = `<div class="list-layout">
<div class="m-tools">
  <div class="search-row"><input class="search" type="search" placeholder="Nom ou épithète…" aria-label="Rechercher un nom ou une épithète" autocomplete="off" spellcheck="false" data-search>
  <button type="button" class="btn-filters" data-open-filters aria-haspopup="dialog" aria-controls="filters">Filtres<span class="badge-n" hidden></span></button></div>
  <div class="el-quick" role="group" aria-label="Élément">${(isMemory() ? [] : ELEMENTS).map(e => `<button type="button" data-el="${e}" data-g="élément" data-v="${e}" aria-pressed="false"><span class="k">${KANJI[e]}</span><span class="lab">${e}</span></button>`).join('')}</div>
  <div class="count-row"><div class="count"><span class="n"></span><span class="of"></span></div><button type="button" class="link-reset" data-reset hidden>Tout réinitialiser</button></div>
  <div class="m-view-tools"><div class="collection-switch seg" role="group" aria-label="Collection"><button type="button" data-collection="personnages" aria-pressed="${!isMemory()}">Personnages</button><button type="button" data-collection="souvenirs" aria-pressed="${isMemory()}">Souvenirs</button></div><div class="m-view seg" role="group" aria-label="Vue"><button type="button" data-view="cartes" aria-pressed="true">Cartes</button><button type="button" data-view="tableau" aria-pressed="false">Tableau</button></div></div>
  <div class="chips"></div>
</div>
<div class="filters-wrap" id="filters-wrap">
  <div class="scrim" data-close-filters></div>
  <div class="filters" id="filters" aria-labelledby="filters-title">
    <div class="sheet-handle" aria-hidden="true"><span></span></div>
    <div class="sheet-head"><h2 id="filters-title">Filtres</h2><div class="actions"><button type="button" class="link-reset" data-reset>Tout réinitialiser</button><button type="button" class="btn-close" data-close-filters aria-label="Fermer les filtres">×</button></div></div>
    <div class="filters-body">
      <input class="search" type="search" placeholder="Nom ou épithète…" aria-label="Rechercher un nom ou une épithète" autocomplete="off" spellcheck="false" data-search>
      ${groups().map(groupHTML).join('')}${isMemory() ? memorySortHTML() : ''}
      <div class="reset-help"><button type="button" class="link-reset" data-reset>Tout réinitialiser</button></div>
    </div>
    <div class="sheet-foot"><button type="button" class="btn-see" data-close-filters></button></div>
  </div>
</div>
<div class="results">
  <div class="d-results-head"><div class="left"><div class="count"><span class="n"></span><span class="of"></span></div><div class="chips"></div></div>
  <div class="view"><div class="collection-switch seg" role="group" aria-label="Collection"><button type="button" data-collection="personnages" aria-pressed="${!isMemory()}">Personnages</button><button type="button" data-collection="souvenirs" aria-pressed="${isMemory()}">Souvenirs</button></div><span class="vl">Vue</span><div class="seg" role="group" aria-label="Vue"><button type="button" data-view="cartes" aria-pressed="true">Cartes</button><button type="button" data-view="tableau" aria-pressed="false">Tableau</button></div></div></div>
  <div class="results-body"></div>
</div></div>`;
    const foot = document.querySelector('body > .site-footer').cloneNode(true);
    foot.classList.add('in-results');
    view.querySelector('.results').appendChild(foot);
  }

  function updateList() {
    const res = sorted(filtered()), n = res.length, act = active(), anything = act.length > 0 || !!state.q.trim() || !!state.tri;
    view.querySelectorAll('[data-search]').forEach(i => { if (i.value !== state.q) i.value = state.q; });
    view.querySelectorAll('.count .n').forEach(e => { e.textContent = n; });
    view.querySelectorAll('.count .of').forEach(e => { e.textContent = (isMemory() ? (n > 1 ? 'souvenirs' : 'souvenir') : (n > 1 ? 'fiches' : 'fiche')) + ' sur ' + collection().length; });
    view.querySelectorAll('.chips').forEach(e => { e.innerHTML = chipsHTML(); });
    view.querySelector('.count-row [data-reset]').hidden = !anything;
    view.querySelectorAll('.reset-help [data-reset], .sheet-head [data-reset]').forEach(b => { b.disabled = !anything; });
    const badge = view.querySelector('.btn-filters .badge-n');
    badge.hidden = !act.length; badge.textContent = act.length;
    view.querySelector('.btn-filters').setAttribute('aria-label', 'Filtres' + (act.length ? ` (${act.length} actif${act.length > 1 ? 's' : ''})` : ''));
    view.querySelectorAll('[data-g][data-v]').forEach(b => b.setAttribute('aria-pressed', String(state[b.dataset.g].includes(b.dataset.v))));
    view.querySelectorAll('[data-sel]').forEach(e => { const k = state[e.dataset.sel].length; e.textContent = k ? k + ' sélect.' : ''; });
    view.querySelector('.btn-see').textContent = 'Voir ' + fiches(n);
    view.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.vue)));
    view.querySelectorAll('[data-memory-sort]').forEach(b => b.setAttribute('aria-pressed', String(state.tri === b.dataset.memorySort)));
    const body = view.querySelector('.results-body');
    body.innerHTML = !n ? emptyHTML() : tableMode() ? tableHTML(res) : `<div class="cards">${res.map(cardHTML).join('')}</div>`;
    live.textContent = fiches(n) + ' sur ' + collection().length;
  }

  function renderList() {
    document.body.dataset.route = 'list';
    document.title = LIST_TITLE;
    if (!view.querySelector('.list-layout') || view.dataset.collection !== state.collection) renderListSkeleton();
    lastListHash = listHash();
    updateList();
  }

  function openSheet() {
    if (DESKTOP.matches) return;
    lastFocus = document.activeElement;
    sheetOpen = true;
    const wrap = view.querySelector('#filters-wrap'), panel = view.querySelector('#filters');
    wrap.classList.add('open');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    document.body.style.overflow = 'hidden';
    panel.querySelector('.btn-close').focus();
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false;
    const wrap = view.querySelector('#filters-wrap'), panel = view.querySelector('#filters');
    if (wrap) wrap.classList.remove('open');
    if (panel) { panel.removeAttribute('role'); panel.removeAttribute('aria-modal'); }
    document.body.style.overflow = '';
    // retour du focus au déclencheur (ou au bouton Filtres si le clic ne l'avait pas donné, ex. Safari)
    const back = lastFocus && lastFocus !== document.body && document.contains(lastFocus) ? lastFocus : view.querySelector('.btn-filters');
    if (back) back.focus();
  }

  /* ---------------- Fiche ---------------- */

  const costIn = t => { const m = String(t || '').match(/coût en énergie occulte\s*:\s*(\d+)/); return m ? +m[1] : null; };
  // Nom court de l'état qui modifie le kit : premier « … » du texte modifié, ou « Dans l'état X, » ; sinon null.
  function stateName(text) {
    const first = String(text || '').split('\n').find(l => l.trim()) || '';
    let m = /«\s*([^»]+?)\s*»/.exec(first);
    if (m && m[1].length <= 24) return m[1];
    m = /dans l['’]état\s+([A-ZÀ-Ý][\p{L}'’ -]{0,22}?)\s*[,(:]/u.exec(first);
    return m ? m[1] : null;
  }

  function skillsOf(d) {
    const s = d['statistiques'] || {};
    const mk = (type, short, b, cost, unit, opts = {}) => {
      const t = p => ({ 1: b[p + 'effet'] || '', 10: b[p + 'effet_niv10'] || '' });
      const modCost = p => b[p + 'coût_énergie'] ?? costIn(b[p + 'effet'] || b[p + 'effet_niv10']);
      return {
        type, short, unit, kind: opts.kind || '', noLevels: !!opts.noLevels, name: b['nom'] || '', cost: cost ?? null,
        names: { v1: b['modifié_nom'], v2: b['modifié2_nom'] },
        text: { base: t(''), v1: t('modifié_'), v2: t('modifié2_') },
        costs: { v1: opts.fixedCost ? cost : modCost('modifié_') ?? cost ?? null, v2: opts.fixedCost ? cost : modCost('modifié2_') ?? cost ?? null },
      };
    };
    const an = d['attaque_normale'] || {}, ul = d['ultime'] || {}, co = d['ultime_coopérative'] || {};
    // L'attaque normale est affichée comme « Compétence 1 » ; les compétences suivantes sont décalées d'un rang.
    const out = [mk('Compétence 1', 'C1', an, null, 'EO', { kind: 'c1' })];
    (d['compétences'] || []).forEach((c, i) => { const n = (c['indice'] ?? i + 1) + 1; out.push(mk('Compétence ' + n, 'C' + n, c, c['coût_énergie'], 'EO', { kind: 'c' + Math.min(n, 3) })); });
    out.push(mk('Ultime', 'Ult.', ul, s['jauge_spéciale'], 'Jauge', { fixedCost: true, kind: 'ult' }));
    (d['compétences_auto'] || []).forEach((c, i) => { const n = c['indice'] ?? i + 1; out.push(mk('Compétence auto ' + n, 'Auto ' + n, c, null, '', { noLevels: true, kind: 'auto' })); });
    if (co['effet']) out.push(mk('Ultime coopérative', 'Coop.', { effet: co['effet'] }, null, '', { noLevels: true, kind: 'coop' }));
    if (co['effet_renforcé']) out.push(mk('Ultime coopérative renforcée', 'Coop.+', { effet: co['effet_renforcé'] }, null, '', { noLevels: true, kind: 'coop' }));
    return out;
  }
  const hasVer = (sk, v) => !!(sk.text[v] && (sk.text[v][1] || sk.text[v][10]));

  function parseLines(txt) {
    const out = []; let gap = false;
    String(txt || '').split('\n').forEach(raw => {
      const l = raw.trim();
      if (!l) { gap = true; return; }
      let ty = 'p', mk = '', t = l;
      if (l[0] === '▼') { ty = 'c'; mk = '▼'; t = l.slice(1).trim(); }
      else if (l[0] === '※') { ty = 'n'; mk = '※'; t = l.slice(1).trim(); }
      else if (l[0] === '·') { ty = 'b'; mk = '–'; t = l.slice(1).trim(); }
      t = t.replace(/\p{L}/u, c => c.toLocaleUpperCase('fr-FR'));
      out.push({ ty, mk, t, en: EN.test(l), sp: !out.length ? '' : gap ? 'gap' : 'near' });
      gap = false;
    });
    return out;
  }
  function lineHTML(ln) {
    const segs = ln.t.split(/(\d+(?:[.,]\d+)?\s?%|«[^»]+»)/g).filter(Boolean).map(s => (/^\d/.test(s) ? `<b class="pc">${esc(s)}</b>` : s[0] === '«' ? `<b class="st">${esc(s)}</b>` : esc(s))).join('');
    return `<div class="ln ${ln.ty} ${ln.sp}"><span class="mk" aria-hidden="true">${ln.mk}</span><span class="t"><span${ln.en ? ' class="en"' : ''}>${segs}</span>${ln.en ? '<span class="en-badge" title="Ligne restée en anglais">EN</span>' : ''}</span></div>`;
  }

  function dateFr(v) {
    const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(v || ''));
    if (!m || !MONTHS[+m[2] - 1]) return v || '—';
    return (+m[1] === 1 ? '1er' : String(+m[1])) + ' ' + MONTHS[+m[2] - 1] + ' ' + m[3];
  }

  function kitHTML(r, skills, lvl, ver, labels) {
    const versions = ['v1', 'v2'].filter(v => skills.some(sk => hasVer(sk, v)));
    const phrase = v => (labels[v].generic ? 'en version ' + labels[v].text.toLowerCase() : 'sous « ' + labels[v].text + ' »');
    let nEN = 0;
    const sections = skills.map((sk, i) => {
      const useVer = ver !== 'base' && hasVer(sk, ver);
      const tv = sk.text[useVer ? ver : 'base'];
      const text = sk.noLevels ? tv[1] || tv[10] : lvl === 10 ? tv[10] || tv[1] : tv[1];
      const missing = !sk.noLevels && lvl === 1 && !tv[1] && !!tv[10];
      const lines = parseLines(text);
      nEN += lines.filter(l => l.en).length;
      const name = useVer ? sk.names[ver] || sk.name : sk.name;
      const cost = useVer ? sk.costs[ver] : sk.cost;
      const own = versions.filter(v => hasVer(sk, v));
      let mod = '';
      if (own.length) {
        const badge = useVer ? `<span class="modbadge on">Version ${esc(labels[ver].text)}</span>` : `<span class="modbadge">Change ${esc(own.map(phrase).join(' / '))}</span>`;
        const was = useVer && cost !== sk.cost ? `<span class="was">Base : ${sk.cost != null ? nf(sk.cost) + ' EO' : 'sans coût'}</span>` : '';
        mod = `<div class="modrow">${badge}${was}</div>`;
      }
      const costBox = cost != null ? `<div class="cost"><span class="num">${nf(cost)}</span><span class="u">${esc(sk.unit)}</span></div>` : '';
      sk.tocCost = cost != null ? nf(cost) + ' ' + sk.unit : '';
      sk.tocName = name || sk.type;
      return `<section class="skill" id="sk-${i}" data-kind="${sk.kind}" aria-label="${esc(sk.type)}${name ? ' : ' + esc(name) : ''}">
<div class="skill-meta"><div class="skill-type">${esc(sk.type)}</div>${costBox}${mod}</div>
<div class="skill-main"><div class="skill-top"><div><div class="skill-type">${esc(sk.type)}</div>${name ? `<h3>${esc(name)}</h3>` : ''}</div>${costBox}</div>${mod}
<div class="lines">${missing ? '<p class="missing">Donnée niv. 1 absente de la source ; aucune valeur inventée.</p>' : lines.length ? lines.map(lineHTML).join('') : '<p class="missing">Aucune description disponible.</p>'}</div></div></section>`;
    }).join('');
    const target = ver !== 'base' ? ver : versions[0];
    const nMod = target ? skills.filter(sk => hasVer(sk, target)).length : 0;
    const notes = [];
    if (target) notes.push(`<span>${nMod} compétence${nMod > 1 ? 's changent' : ' change'} ${esc(phrase(target))}</span>`);
    if (nEN) notes.push(`<span><span class="en-badge">EN</span>${nEN} ligne${nEN > 1 ? 's restées' : ' restée'} en anglais, soulignée${nEN > 1 ? 's' : ''} en pointillé</span>`);
    const verSeg = versions.length ? `<div class="grp"><span class="tlab">Version</span><div class="seg ver v${versions.length + 1}" role="group" aria-label="Version du kit">
<button type="button" data-ver="base" aria-pressed="${ver === 'base'}"><span class="lab" data-t="Base">Base</span></button>${versions.map(v => `<button type="button" class="fill" data-ver="${v}" aria-pressed="${ver === v}"><span class="lab" data-t="${esc(labels[v].text)}">${esc(labels[v].text)}</span></button>`).join('')}</div></div>` : '';
    return `<div class="kit-head"><h2 id="kit-title">Kit de compétences</h2>
<div class="kit-toggles${versions.length ? '' : ' one'}"><div class="grp"><span class="tlab">Niveau</span><div class="seg lvl" role="group" aria-label="Niveau du kit"><button type="button" data-lvl="1" aria-pressed="${lvl === 1}"><span class="lab" data-t="Niv. 1">Niv. 1</span></button><button type="button" data-lvl="10" aria-pressed="${lvl === 10}"><span class="lab" data-t="Niv. 10">Niv. 10</span></button></div></div>${verSeg}</div>
${notes.length ? `<div class="kit-notes">${notes.join('')}</div>` : ''}</div>${notes.length ? `<div class="kit-notes after">${notes.join('')}</div>` : ''}${sections}`;
  }

  function neighbours(r) {
    let list = visibleOrder();
    if (!list.includes(r)) list = DATA.filter(x => x.memory === r.memory);
    const i = list.indexOf(r);
    return { prev: list[i - 1] || null, next: list[i + 1] || null };
  }

  // Kit et sommaire d'une fiche pour un niveau (1/10) et une version (base, v1, v2) donnés par l'URL.
  function ficheKit(r, qs) {
    const p = new URLSearchParams(qs);
    const lvl = p.get('niv') === '10' ? 10 : 1;
    const skills = skillsOf(r.d);
    const versions = ['v1', 'v2'].filter(v => skills.some(sk => hasVer(sk, v)));
    const verParam = { modifiee: 'v1', modifiee2: 'v2' }[p.get('version')];
    const ver = versions.includes(verParam) ? verParam : 'base';
    const labels = {};
    for (const [v, fallback] of [['v1', 'Modifiée'], ['v2', 'Modifiée 2']]) {
      const sk = skills.find(x => hasVer(x, v));
      const nm = sk && stateName(sk.text[v][1] || sk.text[v][10]);
      labels[v] = nm ? { text: nm, generic: false } : { text: fallback, generic: true };
    }
    const kit = kitHTML(r, skills, lvl, ver, labels);
    const toc = `<h2>Sommaire du kit</h2>${skills.map((sk, i) => `<button type="button" data-goto="sk-${i}" data-kind="${sk.kind}"><span class="sh">${esc(sk.short)}</span><span>${esc(sk.tocName)}</span><span class="tc">${esc(sk.tocCost)}</span></button>`).join('')}`;
    return { lvl, kit, toc };
  }

  function renderFiche(route) {
    document.body.dataset.route = 'fiche';
    closeSheet();
    const r = BY_ID.get(route.id);
    if (!r) {
      document.title = 'Fiche introuvable · JJKPP [RK]';
      view.dataset.fiche = '';
      view.innerHTML = `<div class="notfound"><h1 tabindex="-1">Fiche introuvable</h1><p class="mu">Aucune fiche ne porte l'identifiant « ${esc(route.id)} ».</p><a class="btn-outline" href="${esc(lastListHash)}">Toutes les fiches</a></div>`;
      view.querySelector('h1').focus({ preventScroll: true });
      return;
    }
    if (r.memory !== isMemory()) { state.collection = r.memory ? 'souvenirs' : 'personnages'; state.q = ''; GROUPS.forEach(g => {state[g] = [];}); lastListHash = listHash(); }
    if (r.memory) return renderMemory(r);
    const { lvl, kit, toc } = ficheKit(r, route.qs);
    const { prev, next } = neighbours(r);
    const nav = (x, dir) => x ? `<a href="${ficheHref(x)}${lvl === 10 ? '?niv=10' : ''}" data-nav aria-label="Fiche ${dir === 'prev' ? 'précédente' : 'suivante'} : ${esc(x.d['titre'] || x.name)}">${dir === 'prev' ? '‹<span class="who">' + esc(x.name) + '</span>' : '<span class="who">' + esc(x.name) + '</span>›'}</a>`
      : `<a aria-disabled="true" aria-label="Pas de fiche ${dir === 'prev' ? 'précédente' : 'suivante'}">${dir === 'prev' ? '‹' : '›'}</a>`;
    const td = (r.tai || 0) >= (r.juj || 0);
    const sstat = (lab, v, max, strong, k) => `<div data-s="${k}"><div class="lab">${lab}</div><div class="v${strong === false ? ' weak' : ''}">${nf(v)}</div>${max ? `<div class="bar"><i${strong === false ? ' class="weak"' : ''} style="width:${pct(v, max)}"></i></div>` : ''}</div>`;
    document.title = (r.d['titre'] || r.name) + ' · JJKPP [RK]';
    view.innerHTML = `<nav class="m-nav" aria-label="Navigation de fiche"><a class="btn-back" href="${esc(lastListHash)}" data-back><span class="arr" aria-hidden="true">←</span>Fiches</a><div class="pn">${nav(prev, 'prev').replace(/<span class="who">[^<]*<\/span>/, '')}${nav(next, 'next').replace(/<span class="who">[^<]*<\/span>/, '')}</div></nav>
<nav class="d-nav" aria-label="Navigation de fiche"><div class="crumbs"><a class="btn-back" href="${esc(lastListHash)}" data-back>← Toutes les fiches</a><span class="sep" aria-hidden="true">/</span><span class="cur">(${esc(r.epi)}) ${esc(r.name)}</span></div><div class="pn">${nav(prev, 'prev')}${nav(next, 'next')}</div></nav>
<div class="fiche" data-el="${esc(r.el)}">
<div class="fiche-side">
<section class="idcard" aria-label="Identité">
<div class="strip" aria-hidden="true"><span class="k">${r.k}</span><span class="el">${esc(r.el)}</span></div>
<div class="idcard-body">
<div class="idcard-title"><div class="idcard-head"><img class="icon" ${imageAttrs(r.icon, 192)} alt="" decoding="async" width="96" height="96">
<div class="idcard-id"><div class="meta">${marks(r.rar, 'big')}<span class="rar">${esc(r.rar)}</span><span>${esc(r.cats.join(' · '))}</span></div>
<div class="epi">(${esc(r.epi)})</div></div>
${r.rn ? '<span class="stamp-rn" role="img" aria-label="Rayon Noir" title="Rayon Noir"><span>黒</span><span>閃</span></span>' : ''}</div>
<h1 tabindex="-1">${esc(r.name)}</h1></div>
<dl class="info"><dt>Rôle</dt><dd>${esc(r.role || '—')}</dd><dt>Spécialité</dt><dd>${esc(r.spe || '—')}</dd><dt>Affiliation</dt><dd>${esc(r.d['affiliation'] || '—')}</dd><dt>Sortie</dt><dd>${esc(dateFr(r.d['date_de_sortie']))}</dd></dl>
<div class="sgrid">${sstat('PV', r.pv, maxPV, true, 'pv')}${sstat('Taijutsu', r.tai, maxST, td, 'tai')}${sstat('Jujutsu', r.juj, maxST, !td, 'juj')}${sstat('EO init.', r.eoi, 0, undefined, 'eoi')}${sstat('EO max.', r.eom, 0, undefined, 'eom')}${sstat('Jauge sp.', r.js, 0, undefined, 'js')}</div>
</div></section>
<nav class="toc" aria-label="Sommaire du kit">${toc}</nav>
</div>
<section class="kit" id="kit" aria-labelledby="kit-title">${kit}</section>
</div>`;
    view.dataset.fiche = r.id;
    window.scrollTo(0, 0);
    view.querySelector('h1').focus({ preventScroll: true });
  }

  // Bascule niv. / version : URL mise à jour sans nouvelle entrée d'historique ; seuls le kit et le sommaire sont redessinés.
  function setFicheParam(key, value, attr) {
    const route = parseRoute();
    const r = route.name === 'fiche' && BY_ID.get(route.id);
    if (!r) return;
    const p = new URLSearchParams(route.qs);
    if (value == null) p.delete(key); else p.set(key, value);
    const s = p.toString();
    history.replaceState(null, '', '#/fiche/' + encodeURIComponent(route.id) + (s ? '?' + s : ''));
    const { lvl, kit, toc } = ficheKit(r, s);
    // Les sélecteurs déjà affichés sont gardés tels quels : seul aria-pressed change, la pastille et les couleurs glissent sans saut.
    const keep = view.querySelector('#kit .kit-toggles');
    view.querySelector('#kit').innerHTML = kit;
    const fresh = view.querySelector('#kit .kit-toggles');
    if (keep && fresh && keep.querySelectorAll('button').length === fresh.querySelectorAll('button').length) {
      const pressed = [...fresh.querySelectorAll('button')].map(b => b.getAttribute('aria-pressed'));
      fresh.replaceWith(keep);
      keep.querySelectorAll('button').forEach((b, i) => { if (b.getAttribute('aria-pressed') !== pressed[i]) b.setAttribute('aria-pressed', pressed[i]); });
    }
    view.querySelector('.toc').innerHTML = toc;
    view.querySelectorAll('[data-nav][href]').forEach(a => { a.setAttribute('href', a.getAttribute('href').split('?')[0] + (lvl === 10 ? '?niv=10' : '')); });
    const again = view.querySelector(`#kit [${attr.name}="${attr.value}"]`);
    if (again) again.focus({ preventScroll: true });
  }

  /* ---------------- Routage ---------------- */

  async function onRoute() {
    clearTimeout(searchTimer);
    const version = ++routeVersion;
    const r = parseRoute();
    const target = r.name === 'fiche'
      ? (r.id.startsWith('souvenir-') ? 'souvenirs' : 'personnages')
      : (new URLSearchParams(r.qs).get('collection') === 'souvenirs' ? 'souvenirs' : 'personnages');
    view.setAttribute('aria-busy', 'true');
    if (!collectionRequests.has(target)) view.innerHTML = '<p class="noscript" role="status">Chargement des fiches…</p>';
    try {
      await loadCollection(target);
    } catch (error) {
      if (version !== routeVersion) return;
      view.removeAttribute('aria-busy');
      view.innerHTML = '<p class="noscript" role="alert">Impossible de charger les fiches. <button type="button" data-retry>Réessayer</button></p>';
      return;
    }
    if (version !== routeVersion) return;
    view.removeAttribute('aria-busy');
    if (r.name === 'fiche') {
      if (current === 'list') { listScroll = window.scrollY; cameFromList = true; }
      current = 'fiche';
      renderFiche(r);
    } else {
      const back = current === 'fiche';
      current = 'list';
      cameFromList = false;
      readListParams(r.qs);
      renderList();
      if (back) requestAnimationFrame(() => window.scrollTo(0, listScroll));
    }
  }

  /* ---------------- Événements ---------------- */

  document.addEventListener('error', e => {
    const img = e.target;
    if (img instanceof HTMLImageElement && img.dataset.originalSrc) {
      const source = img.dataset.originalSrc;
      delete img.dataset.originalSrc;
      img.removeAttribute('srcset');
      img.removeAttribute('sizes');
      if (img.getAttribute('src') !== source) img.src = source;
    }
  }, true);

  document.addEventListener('click', e => {
    if (e.target.closest('[data-retry]')) return onRoute();
    const t = e.target.closest('button[data-collection],[data-memory-sort],[data-theme-set],[data-g],[data-remove],[data-reset],[data-open-filters],[data-close-filters],[data-view],[data-sort],[data-back],[data-nav],[data-lvl],[data-ver],[data-goto],tr[data-href]');
    if (!t) return;
    if (t.dataset.collection) {
      state.collection = t.dataset.collection; state.q = ''; state.tri = ''; state.ordre = 'desc'; GROUPS.forEach(g => { state[g] = []; });
      lastListHash = listHash();
      history.replaceState(null, '', lastListHash);
      return onRoute();
    }
    if (t.dataset.memorySort) { state.tri = t.dataset.memorySort; state.ordre = 'desc'; return commitList(); }
    if (t.dataset.themeSet) return setTheme(t.dataset.themeSet);
    if (t.dataset.g) {
      const list = state[t.dataset.g], v = t.dataset.v;
      state[t.dataset.g] = list.includes(v) ? list.filter(x => x !== v) : list.concat(v);
      return commitList();
    }
    if (t.dataset.remove) {
      if (t.dataset.remove === 'q') state.q = '';
      else { const [g, v] = t.dataset.remove.split('|'); state[g] = state[g].filter(x => x !== v); }
      return commitList();
    }
    if (t.hasAttribute('data-reset')) { state.q = ''; state.tri = ''; state.ordre = 'desc'; GROUPS.forEach(g => { state[g] = []; }); return commitList(); }
    if (t.hasAttribute('data-open-filters')) return openSheet();
    if (t.hasAttribute('data-close-filters')) return closeSheet();
    if (t.dataset.view) { state.vue = t.dataset.view; return commitList(); }
    if (t.dataset.sort) {
      const k = t.dataset.sort;
      if (state.tri === k) state.ordre = state.ordre === 'desc' ? 'asc' : 'desc';
      else { state.tri = k; state.ordre = k === 'personnage' ? 'asc' : 'desc'; }
      return commitList();
    }
    if (t.hasAttribute('data-back') && cameFromList) { e.preventDefault(); return history.back(); }
    if (t.hasAttribute('data-nav')) { e.preventDefault(); return location.replace(t.getAttribute('href')); }
    if (t.dataset.lvl) return setFicheParam('niv', t.dataset.lvl === '10' ? '10' : null, { name: 'data-lvl', value: t.dataset.lvl });
    if (t.dataset.ver) return setFicheParam('version', { v1: 'modifiee', v2: 'modifiee2' }[t.dataset.ver] || null, { name: 'data-ver', value: t.dataset.ver });
    if (t.dataset.goto) { const s = document.getElementById(t.dataset.goto); if (s) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (t.matches('tr[data-href]') && !e.target.closest('a')) location.hash = t.dataset.href;
  });

  document.addEventListener('input', e => {
    if (!e.target.matches('[data-search]')) return;
    state.q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(commitList, 120);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && sheetOpen) { closeSheet(); return; }
    if (sheetOpen && e.key === 'Tab') {
      const panel = view.querySelector('#filters');
      const f = [...panel.querySelectorAll('button,input')].filter(x => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });

  /* ---------------- Segments : pastille glissante ---------------- */

  // La pastille (::before du .seg) est placée sous le bouton pressé via des variables CSS ; un changement de bouton la fait glisser.
  function segBox(g) {
    return g.classList.contains('seg-on') ? ['--seg-x', '--seg-y', '--seg-w', '--seg-h'].map(v => g.style.getPropertyValue(v)) : null;
  }
  function setBox(g, box) { ['--seg-x', '--seg-y', '--seg-w', '--seg-h'].forEach((v, i) => g.style.setProperty(v, box[i])); }
  function placeSeg(g, from) {
    const on = g.querySelector(':scope>button[aria-pressed="true"]');
    if (!on || !on.offsetWidth) { g.classList.remove('seg-on'); return; }
    const box = [on.offsetLeft + 'px', on.offsetTop + 'px', on.offsetWidth + 'px', on.offsetHeight + 'px'];
    const animate = from || segBox(g);
    g.classList.add('seg-still');
    if (animate) setBox(g, animate); else setBox(g, box);
    g.classList.toggle('seg-fill', on.classList.contains('fill'));
    g.classList.add('seg-on');
    void g.offsetWidth;
    g.classList.remove('seg-still');
    if (animate) setBox(g, box);
  }
  const placeAllSegs = () => document.querySelectorAll('.seg').forEach(g => { g.classList.remove('seg-on'); placeSeg(g); });
  new MutationObserver(muts => {
    const seen = new Set();
    muts.forEach(m => {
      if (m.type === 'attributes') { const g = m.target.parentElement; if (g && g.classList.contains('seg')) seen.add(g); return; }
      m.addedNodes.forEach(n => { if (n.nodeType === 1) (n.matches('.seg') ? [n] : n.querySelectorAll('.seg')).forEach(g => { if (!g.classList.contains('seg-on')) seen.add(g); }); });
    });
    seen.forEach(g => placeSeg(g));
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-pressed'] });
  window.addEventListener('resize', placeAllSegs);
  if (document.fonts) document.fonts.ready.then(placeAllSegs);

  DESKTOP.addEventListener('change', () => {
    closeSheet();
    if (current === 'list') updateList();
  });
  window.addEventListener('hashchange', onRoute);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  paintTheme();
  placeAllSegs();

  const getJSON = url => fetch(url).then(res => { if (!res.ok) throw new Error(url + ' : HTTP ' + res.status); return res.json(); });
  function loadCollection(name) {
    if (collectionRequests.has(name)) return collectionRequests.get(name);
    if (!categoriesRequest) categoriesRequest = getJSON('data/categories.json').catch(error => { categoriesRequest = null; throw error; });
    const request = Promise.all([
      getJSON(name === 'souvenirs' ? 'data/souvenirs.json' : 'data/characters.json'), categoriesRequest,
    ]).then(([list, categories]) => {
      rawCollections[name] = list;
      prepare(rawCollections.personnages, categories['catégories'] || {}, rawCollections.souvenirs);
    }).catch(error => { collectionRequests.delete(name); throw error; });
    collectionRequests.set(name, request);
    return request;
  }
  onRoute();
})();
