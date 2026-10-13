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
  const fiches = n => n + ' ' + (n > 1 ? 'fiches' : 'fiche');
  const pct = (v, max) => Math.max(3, Math.round((v || 0) / max * 100)) + '%';
  const marks = (r, cls = '') => `<span class="marks r${RANK[r] || 1}${cls ? ' ' + cls : ''}" aria-hidden="true"><i></i><i></i><i></i></span>`;
  const ficheHref = r => '#/fiche/' + encodeURIComponent(r.id);

  let DATA = [], BY_ID = new Map(), CATEGORIES = [], maxPV = 1, maxST = 1;
  const state = { q: '', 'élément': [], 'rareté': [], 'catégorie': [], 'spécialité': [], vue: 'cartes', tri: '', ordre: 'desc' };
  let current = null, listScroll = 0, cameFromList = false, lastListHash = '#/', sheetOpen = false, lastFocus = null;

  /* ---------------- Données ---------------- */

  function prepare(list, categoryRoles) {
    CATEGORIES = Object.keys(categoryRoles);
    const roleCats = {};
    for (const [cat, roles] of Object.entries(categoryRoles)) for (const role of roles) (roleCats[role] = roleCats[role] || []).push(cat);
    const used = new Set();
    DATA = list.map((d, i) => {
      const s = d['statistiques'] || {};
      // identifiant stable pour l'URL : clé d'image du jeu (unique), sinon clé d'icône
      let id = String(d['clé_image'] || d['clé_icône'] || 'fiche-' + (i + 1));
      while (used.has(id)) id += '-' + (i + 1);
      used.add(id);
      const epi = d['épithète'] || (/^\((.*)\)/.exec(d['titre'] || '') || [])[1] || '';
      const name = d['nom'] || d['titre'] || '';
      const cats = Array.isArray(d['catégories']) && d['catégories'].length ? d['catégories'] : (roleCats[d['rôle']] || []);
      return {
        d, id, i, el: d['élément'] || '', k: KANJI[d['élément']] || '', epi, name, rar: d['rareté'] || '', role: d['rôle'] || '', spe: d['spécialité'] || '', cats,
        pv: s['pv'], tai: s['atq'], juj: s['jujutsu'], eoi: s['énergie_occulte_initiale'], eom: s['énergie_occulte_max'], js: s['jauge_spéciale'],
        rn: s['rayon_noir'] === 'Oui', icon: d['url_icône'] || '', search: norm(epi + ' ' + name + ' ' + (d['titre'] || '')),
      };
    });
    maxPV = Math.max(1, ...DATA.map(r => r.pv || 0));
    maxST = Math.max(1, ...DATA.map(r => Math.max(r.tai || 0, r.juj || 0)));
    BY_ID = new Map(DATA.map(r => [r.id, r]));
  }

  /* ---------------- Filtres : OU dans un groupe, ET entre groupes ---------------- */

  const has = (r, g, v) => (g === 'élément' ? r.el === v : g === 'rareté' ? r.rar === v : g === 'spécialité' ? r.spe === v : r.cats.includes(v));
  function matches(r, st, skip) {
    const q = norm(st.q.trim());
    if (skip !== 'q' && q && !r.search.includes(q)) return false;
    return GROUPS.every(g => g === skip || !st[g].length || st[g].some(v => has(r, g, v)));
  }
  const filtered = (st = state) => DATA.filter(r => matches(r, st));
  const active = (st = state) => GROUPS.flatMap(g => st[g].map(v => ({ g, v })));
  const options = g => (g === 'élément' ? ELEMENTS : g === 'rareté' ? RARITIES : g === 'catégorie' ? CATEGORIES : SPECIALITIES);

  const SORTS = {
    personnage: r => norm(r.name + ' ' + r.epi),
    rarete: r => RANK[r.rar] || 0,
    pv: r => r.pv ?? -1, tai: r => r.tai ?? -1, juj: r => r.juj ?? -1,
  };
  function sorted(list) {
    const key = SORTS[state.tri];
    if (!key) return list;
    const dir = state.ordre === 'asc' ? 1 : -1;
    return list.slice().sort((a, b) => {
      const x = key(a), y = key(b);
      return (typeof x === 'string' ? x.localeCompare(y, 'fr') : x - y) * dir || a.i - b.i;
    });
  }
  const tableMode = () => DESKTOP.matches && state.vue === 'tableau';
  const visibleOrder = () => (tableMode() ? sorted(filtered()) : filtered());

  /* ---------------- URL ---------------- */

  function listHash() {
    const p = new URLSearchParams();
    if (state.q.trim()) p.set('q', state.q.trim());
    for (const g of GROUPS) if (state[g].length) p.set(PARAM[g], state[g].join(','));
    if (state.vue === 'tableau') p.set('vue', 'tableau');
    if (state.tri) p.set('tri', state.tri + '-' + state.ordre);
    const s = p.toString();
    return '#/' + (s ? '?' + s : '');
  }
  function readListParams(qs) {
    const p = new URLSearchParams(qs);
    state.q = p.get('q') || '';
    for (const g of GROUPS) state[g] = (p.get(PARAM[g]) || '').split(',').filter(v => options(g).includes(v));
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

  function cardHTML(r) {
    const td = (r.tai || 0) >= (r.juj || 0);
    const stat = (short, long, v, max, strong) => `<div class="stat"><div class="stat-top"><span class="lab"><span class="lab-short">${short}</span><span class="lab-long">${long}</span></span><span class="v${strong ? '' : ' weak'}">${nf(v)}</span></div><div class="bar"><i${strong ? '' : ' class="weak"'} style="width:${pct(v, max)}"></i></div></div>`;
    return `<a class="card" data-el="${esc(r.el)}" href="${ficheHref(r)}" aria-label="${esc(r.d['titre'] || r.name)} — ${esc(r.rar)}, ${esc(r.el)}">
<div class="strip" aria-hidden="true"><span class="k">${r.k}</span><span class="el">${esc(r.el)}</span></div>
<div class="card-body">
<div class="card-head"><img class="icon" src="${esc(r.icon)}" alt="" loading="lazy" decoding="async" width="56" height="56">
<div class="card-id"><div class="meta">${marks(r.rar)}<span class="rar">${esc(r.rar)}</span><span class="role">${esc(r.role || '—')}<span class="m-only"> · ${esc(r.spe || '—')}</span></span></div>
<div class="epi">(${esc(r.epi)})</div><div class="name">${esc(r.name)}</div></div>
${r.rn ? '<span class="stamp-rn" title="Rayon Noir"><span>黒</span><span>閃</span></span>' : ''}</div>
<div class="stats">${stat('PV', 'PV', r.pv, maxPV, true)}${stat('TAI', 'TAIJUTSU', r.tai, maxST, td)}${stat('JUJ', 'JUJUTSU', r.juj, maxST, !td)}</div>
<div class="card-foot"><span>EO <span class="num">${nf(r.eoi)}</span> / <span class="num">${nf(r.eom)}</span></span><span>Jauge<span class="m-only"> sp.</span> <span class="num">${nf(r.js)}</span></span>${r.rn ? '<span class="end rn m-only">Rayon Noir</span>' : ''}<span class="end d-only">${esc(r.spe)}</span></div>
</div></a>`;
  }

  function tableHTML(list) {
    const th = (key, label, cls = '') => {
      if (!key) return `<th scope="col"${cls ? ` class="${cls}"` : ''}>${label}</th>`;
      const on = state.tri === key, arrow = on ? (state.ordre === 'asc' ? '↑' : '↓') : '↕';
      return `<th scope="col"${cls ? ` class="${cls}"` : ''}${on ? ` aria-sort="${state.ordre === 'asc' ? 'ascending' : 'descending'}"` : ''}><button type="button" data-sort="${key}">${label} <span class="arr" aria-hidden="true">${arrow}</span></button></th>`;
    };
    const num = (v, max, strong) => `<td class="tnum"><div class="v${strong ? '' : ' weak'}">${nf(v)}</div><div class="bar"><i${strong ? '' : ' class="weak"'} style="width:${pct(v, max)}"></i></div></td>`;
    const rows = list.map(r => {
      const td = (r.tai || 0) >= (r.juj || 0);
      return `<tr data-href="${ficheHref(r)}"><td><span class="tk" data-el="${esc(r.el)}" aria-label="${esc(r.el)}"><span class="k">${r.k}</span></span></td>
<td><img class="icon" src="${esc(r.icon)}" alt="" loading="lazy" decoding="async" width="38" height="38"></td>
<td class="tname"><div class="epi">(${esc(r.epi)})</div><a href="${ficheHref(r)}">${esc(r.name)}</a></td>
<td><span class="trar">${marks(r.rar)}<span class="num">${esc(r.rar)}</span></span></td><td>${esc(r.role || '—')}</td><td class="mu">${esc(r.spe || '—')}</td>
${num(r.pv, maxPV, true)}${num(r.tai, maxST, td)}${num(r.juj, maxST, !td)}
<td class="ts">${nf(r.eoi)}</td><td class="ts">${nf(r.eom)}</td><td class="ts">${nf(r.js)}</td><td class="tc">${r.rn ? '<span class="stamp-rn row" role="img" aria-label="Rayon Noir" title="Rayon Noir"><span>黒</span><span>閃</span></span>' : ''}</td></tr>`;
    }).join('');
    return `<div class="table-wrap"><table class="ftable"><caption class="visually-hidden">Fiches, cliquez un en-tête pour trier</caption>
<colgroup><col style="width:36px"><col style="width:48px"><col><col style="width:60px"><col style="width:100px"><col style="width:80px"><col style="width:104px"><col style="width:104px"><col style="width:104px"><col style="width:56px"><col style="width:56px"><col style="width:68px"><col style="width:40px"></colgroup>
<thead><tr>${th('', '<span class="visually-hidden">Élément</span>')}${th('', '<span class="visually-hidden">Icône</span>')}${th('personnage', 'Personnage')}${th('rarete', 'Rar.')}${th('', 'Rôle')}${th('', 'Spécialité')}${th('pv', 'PV', 'r')}${th('tai', 'Taijutsu', 'r')}${th('juj', 'Jujutsu', 'r')}${th('', 'EO in.', 'r s')}${th('', 'EO max', 'r s')}${th('', 'Jauge', 'r s')}${th('', '<span title="Rayon Noir">黒閃</span>', 'c')}</tr></thead>
<tbody>${rows}</tbody></table></div>`;
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
<button type="button" class="btn-outline" data-reset>Tout réinitialiser · ${DATA.length} fiches</button></div>`;
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
      `<button type="button" data-g="${g}" data-v="${esc(v)}" aria-pressed="false">${g === 'rareté' ? marks(v) : ''}${esc(v)}</button>`).join('')}</div></div>`;
  }

  function renderListSkeleton() {
    view.innerHTML = `<div class="list-layout">
<div class="m-tools">
  <div class="search-row"><input class="search" type="search" placeholder="Nom ou épithète…" aria-label="Rechercher un nom ou une épithète" autocomplete="off" spellcheck="false" data-search>
  <button type="button" class="btn-filters" data-open-filters aria-haspopup="dialog" aria-controls="filters">Filtres<span class="badge-n" hidden></span></button></div>
  <div class="el-quick" role="group" aria-label="Élément">${ELEMENTS.map(e => `<button type="button" data-el="${e}" data-g="élément" data-v="${e}" aria-pressed="false"><span class="k">${KANJI[e]}</span><span class="lab">${e}</span></button>`).join('')}</div>
  <div class="count-row"><div class="count"><span class="n"></span><span class="of"></span></div><button type="button" class="link-reset" data-reset hidden>Tout réinitialiser</button></div>
  <div class="chips"></div>
</div>
<div class="filters-wrap" id="filters-wrap">
  <div class="scrim" data-close-filters></div>
  <div class="filters" id="filters" aria-labelledby="filters-title">
    <div class="sheet-handle" aria-hidden="true"><span></span></div>
    <div class="sheet-head"><h2 id="filters-title">Filtres</h2><div class="actions"><button type="button" class="link-reset" data-reset>Tout réinitialiser</button><button type="button" class="btn-close" data-close-filters aria-label="Fermer les filtres">×</button></div></div>
    <div class="filters-body">
      <input class="search" type="search" placeholder="Nom ou épithète…" aria-label="Rechercher un nom ou une épithète" autocomplete="off" spellcheck="false" data-search>
      ${GROUPS.map(groupHTML).join('')}
      <div class="reset-help"><button type="button" class="link-reset" data-reset>Tout réinitialiser</button><span>Plusieurs choix dans un groupe : l'un ou l'autre. Entre groupes : tous à la fois.</span></div>
    </div>
    <div class="sheet-foot"><button type="button" class="btn-see" data-close-filters></button></div>
  </div>
</div>
<div class="results">
  <div class="d-results-head"><div class="left"><div class="count"><span class="n"></span><span class="of"></span></div><div class="chips"></div></div>
  <div class="view"><span class="vl">Vue</span><div class="seg" role="group" aria-label="Vue"><button type="button" data-view="cartes" aria-pressed="true">Cartes</button><button type="button" data-view="tableau" aria-pressed="false">Tableau</button></div></div></div>
  <div class="results-body"></div>
</div></div>`;
    const foot = document.querySelector('body > .site-footer').cloneNode(true);
    foot.classList.add('in-results');
    view.querySelector('.results').appendChild(foot);
  }

  function updateList() {
    const res = filtered(), n = res.length, act = active(), anything = act.length > 0 || !!state.q.trim();
    view.querySelectorAll('[data-search]').forEach(i => { if (i.value !== state.q) i.value = state.q; });
    view.querySelectorAll('.count .n').forEach(e => { e.textContent = n; });
    view.querySelectorAll('.count .of').forEach(e => { e.textContent = (n > 1 ? 'fiches' : 'fiche') + ' sur ' + DATA.length; });
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
    const body = view.querySelector('.results-body');
    body.innerHTML = !n ? emptyHTML() : tableMode() ? tableHTML(sorted(res)) : `<div class="cards">${res.map(cardHTML).join('')}</div>`;
    live.textContent = fiches(n) + ' sur ' + DATA.length;
  }

  function renderList() {
    document.body.dataset.route = 'list';
    document.title = LIST_TITLE;
    if (!view.querySelector('.list-layout')) renderListSkeleton();
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
        type, short, unit, noLevels: !!opts.noLevels, name: b['nom'] || '', cost: cost ?? null,
        names: { v1: b['modifié_nom'], v2: b['modifié2_nom'] },
        text: { base: t(''), v1: t('modifié_'), v2: t('modifié2_') },
        costs: { v1: opts.fixedCost ? cost : modCost('modifié_') ?? cost ?? null, v2: opts.fixedCost ? cost : modCost('modifié2_') ?? cost ?? null },
      };
    };
    const an = d['attaque_normale'] || {}, ul = d['ultime'] || {}, co = d['ultime_coopérative'] || {};
    const out = [mk('Attaque normale', 'Norm.', an, null, 'EO')];
    (d['compétences'] || []).forEach((c, i) => { const n = c['indice'] ?? i + 1; out.push(mk('Compétence ' + n, 'C' + n, c, c['coût_énergie'], 'EO')); });
    out.push(mk('Ultime', 'Ult.', ul, s['jauge_spéciale'], 'Jauge', { fixedCost: true }));
    (d['compétences_auto'] || []).forEach((c, i) => { const n = c['indice'] ?? i + 1; out.push(mk('Compétence auto ' + n, 'Auto ' + n, c, null, '', { noLevels: true })); });
    if (co['effet']) out.push(mk('Ultime coopérative', 'Coop.', { effet: co['effet'] }, null, '', { noLevels: true }));
    if (co['effet_renforcé']) out.push(mk('Ultime coopérative renforcée', 'Coop.+', { effet: co['effet_renforcé'] }, null, '', { noLevels: true }));
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
      out.push({ ty, mk, t, en: EN.test(l), sp: !out.length ? '' : gap ? 'gap' : 'near' });
      gap = false;
    });
    return out;
  }
  function lineHTML(ln) {
    const segs = ln.t.split(/(\d+(?:[.,]\d+)?\s?%|«[^»]+»)/g).filter(Boolean).map(s => (/^(\d|«)/.test(s) ? `<b>${esc(s)}</b>` : esc(s))).join('');
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
      return `<section class="skill" id="sk-${i}" aria-label="${esc(sk.type)}${name ? ' : ' + esc(name) : ''}">
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
<button type="button" data-ver="base" aria-pressed="${ver === 'base'}">Base</button>${versions.map(v => `<button type="button" class="fill" data-ver="${v}" aria-pressed="${ver === v}">${esc(labels[v].text)}</button>`).join('')}</div></div>` : '';
    return `<div class="kit-head"><h2 id="kit-title">Kit de compétences</h2>
<div class="kit-toggles${versions.length ? '' : ' one'}"><div class="grp"><span class="tlab">Niveau</span><div class="seg lvl" role="group" aria-label="Niveau du kit"><button type="button" data-lvl="1" aria-pressed="${lvl === 1}">Niv. 1</button><button type="button" data-lvl="10" aria-pressed="${lvl === 10}">Niv. 10</button></div></div>${verSeg}</div>
${notes.length ? `<div class="kit-notes">${notes.join('')}</div>` : ''}</div>${notes.length ? `<div class="kit-notes after">${notes.join('')}</div>` : ''}${sections}`;
  }

  function neighbours(r) {
    let list = visibleOrder();
    if (!list.includes(r)) list = DATA;
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
    const toc = `<h2>Sommaire du kit</h2>${skills.map((sk, i) => `<button type="button" data-goto="sk-${i}"><span class="sh">${esc(sk.short)}</span><span>${esc(sk.tocName)}</span><span class="tc">${esc(sk.tocCost)}</span></button>`).join('')}`;
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
    const { lvl, kit, toc } = ficheKit(r, route.qs);
    const { prev, next } = neighbours(r);
    const nav = (x, dir) => x ? `<a href="${ficheHref(x)}${lvl === 10 ? '?niv=10' : ''}" data-nav aria-label="Fiche ${dir === 'prev' ? 'précédente' : 'suivante'} : ${esc(x.d['titre'] || x.name)}">${dir === 'prev' ? '‹<span class="who">' + esc(x.name) + '</span>' : '<span class="who">' + esc(x.name) + '</span>›'}</a>`
      : `<a aria-disabled="true" aria-label="Pas de fiche ${dir === 'prev' ? 'précédente' : 'suivante'}">${dir === 'prev' ? '‹' : '›'}</a>`;
    const td = (r.tai || 0) >= (r.juj || 0);
    const sstat = (lab, v, max, strong) => `<div><div class="lab">${lab}</div><div class="v${strong === false ? ' weak' : ''}">${nf(v)}</div>${max ? `<div class="bar"><i${strong === false ? ' class="weak"' : ''} style="width:${pct(v, max)}"></i></div>` : ''}</div>`;
    document.title = (r.d['titre'] || r.name) + ' · JJKPP [RK]';
    view.innerHTML = `<nav class="m-nav" aria-label="Navigation de fiche"><a class="btn-back" href="${esc(lastListHash)}" data-back><span class="arr" aria-hidden="true">←</span>Fiches</a><div class="pn">${nav(prev, 'prev').replace(/<span class="who">[^<]*<\/span>/, '')}${nav(next, 'next').replace(/<span class="who">[^<]*<\/span>/, '')}</div></nav>
<nav class="d-nav" aria-label="Navigation de fiche"><div class="crumbs"><a class="btn-back" href="${esc(lastListHash)}" data-back>← Toutes les fiches</a><span class="sep" aria-hidden="true">/</span><span class="cur">(${esc(r.epi)}) ${esc(r.name)}</span></div><div class="pn">${nav(prev, 'prev')}${nav(next, 'next')}</div></nav>
<div class="fiche" data-el="${esc(r.el)}">
<div class="fiche-side">
<section class="idcard" aria-label="Identité">
<div class="strip" aria-hidden="true"><span class="k">${r.k}</span><span class="el">${esc(r.el)}</span></div>
<div class="idcard-body">
<div class="idcard-head"><img class="icon" src="${esc(r.icon)}" alt="" decoding="async" width="128" height="128">
<div class="idcard-id"><div class="meta">${marks(r.rar, 'big')}<span class="rar">${esc(r.rar)}</span><span>${esc(r.cats.join(' · '))}</span></div>
<div class="epi">(${esc(r.epi)})</div><h1 tabindex="-1">${esc(r.name)}</h1></div>
${r.rn ? '<span class="stamp-rn" role="img" aria-label="Rayon Noir" title="Rayon Noir"><span>黒</span><span>閃</span></span>' : ''}</div>
<dl class="info"><dt>Rôle</dt><dd>${esc(r.role || '—')}</dd><dt>Spécialité</dt><dd>${esc(r.spe || '—')}</dd><dt>Affiliation</dt><dd>${esc(r.d['affiliation'] || '—')}</dd><dt>Sortie</dt><dd>${esc(dateFr(r.d['date_de_sortie']))}</dd></dl>
<div class="sgrid">${sstat('PV', r.pv, maxPV, true)}${sstat('Taijutsu', r.tai, maxST, td)}${sstat('Jujutsu', r.juj, maxST, !td)}${sstat('EO init.', r.eoi)}${sstat('EO max.', r.eom)}${sstat('Jauge sp.', r.js)}</div>
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
    view.querySelector('#kit').innerHTML = kit;
    view.querySelector('.toc').innerHTML = toc;
    view.querySelectorAll('[data-nav][href]').forEach(a => { a.setAttribute('href', a.getAttribute('href').split('?')[0] + (lvl === 10 ? '?niv=10' : '')); });
    const again = view.querySelector(`#kit [${attr.name}="${attr.value}"]`);
    if (again) again.focus({ preventScroll: true });
  }

  /* ---------------- Routage ---------------- */

  function onRoute() {
    const r = parseRoute();
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

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-theme-set],[data-g],[data-remove],[data-reset],[data-open-filters],[data-close-filters],[data-view],[data-sort],[data-back],[data-nav],[data-lvl],[data-ver],[data-goto],tr[data-href]');
    if (!t) return;
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
    if (t.hasAttribute('data-reset')) { state.q = ''; GROUPS.forEach(g => { state[g] = []; }); return commitList(); }
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
    commitList();
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

  DESKTOP.addEventListener('change', () => {
    closeSheet();
    if (current === 'list') updateList();
  });
  window.addEventListener('hashchange', onRoute);
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  paintTheme();

  const getJSON = url => fetch(url).then(res => { if (!res.ok) throw new Error(url + ' : HTTP ' + res.status); return res.json(); });
  Promise.all([getJSON('data/characters.json'), getJSON('data/categories.json')])
    .then(([list, categories]) => { prepare(list, categories['catégories'] || {}); onRoute(); })
    .catch(error => {
      console.error(error);
      view.innerHTML = '<p class="noscript">Impossible de charger les fiches (data/characters.json). Réessayez plus tard.</p>';
    });
})();
