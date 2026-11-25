import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../assets/app.js', import.meta.url), 'utf8');
const characters = JSON.parse(fs.readFileSync(new URL('../../data/characters.json', import.meta.url)));
const memories = JSON.parse(fs.readFileSync(new URL('../../data/souvenirs.json', import.meta.url)));

function browser(fetch) {
  const view = { setAttribute() {}, removeAttribute() {}, innerHTML: '', dataset: { collection: 'personnages' }, querySelectorAll: () => [] };
  const location = { hash: '#/' };
  const listeners = {};
  const context = vm.createContext({
    listeners, HTMLImageElement: class {},
    fetch, URLSearchParams, setTimeout, clearTimeout,
    location, history: { replaceState(_state, _title, hash) { location.hash = hash; } },
    document: {
      title: 'Test', body: {}, fonts: null,
      getElementById: () => view, querySelectorAll: () => [], querySelector: () => null,
      documentElement: { getAttribute: () => 'dark' }, addEventListener(type, handler) { listeners[type] = handler; },
    },
    window: { matchMedia: () => ({ addEventListener() {} }), addEventListener() {} },
    MutationObserver: class { observe() {} },
    requestAnimationFrame: fn => fn(),
  });
  vm.runInContext(source.replace('  onRoute();\n})();', `
    globalThis.renders = [];
    renderList = () => renders.push(state.collection);
    updateList = () => renders.push(state.collection);
    renderFiche = route => renders.push(route.id);
    globalThis.api = { loadCollection, onRoute, records: () => DATA, visibleOrder, imageAttrs, cardHTML, ficheKit, transitionContent, state, commitList, bonusHTML };
  })();`), context);
  return context;
}
const response = url => Promise.resolve({ ok: true, json: async () => url.includes('categories') ? { catégories: {} } : url.includes('souvenirs') ? memories : characters });

test('la première liste charge uniquement les personnages et partage les requêtes suivantes', async () => {
  const calls = [];
  const b = browser(url => { calls.push(url); return response(url); });
  await b.api.onRoute();
  assert.deepEqual(calls.sort(), ['data/categories.json', 'data/characters.json']);
  await Promise.all([b.api.loadCollection('souvenirs'), b.api.loadCollection('souvenirs')]);
  assert.equal(calls.filter(url => url.includes('souvenirs')).length, 1);
  assert.equal(b.api.records().length, characters.length + memories.length);
  assert.equal(new Set(b.api.records().map(r => r.id)).size, characters.length + memories.length);
});

test('un lien direct vers un souvenir évite de télécharger les personnages', async () => {
  const calls = [];
  const b = browser(url => { calls.push(url); return response(url); });
  b.location.hash = '#/fiche/' + encodeURIComponent(memories[0].id);
  await b.api.onRoute();
  assert.ok(!calls.includes('data/characters.json'));
  assert.equal(b.renders[0], memories[0].id);
});

test('une requête échouée peut être relancée', async () => {
  let fail = true;
  const b = browser(url => fail && url.includes('characters') ? Promise.reject(new Error('offline')) : response(url));
  await assert.rejects(b.api.loadCollection('personnages'));
  fail = false;
  await b.api.loadCollection('personnages');
  assert.equal(b.api.records().length, characters.length);
});

test('une ancienne navigation ne remplace pas la collection demandée ensuite', async () => {
  let release;
  const b = browser(url => url.includes('characters') ? new Promise(resolve => { release = () => resolve(response(url)); }) : response(url));
  const first = b.api.onRoute();
  b.location.hash = '#/?collection=souvenirs';
  await b.api.onRoute();
  release();
  await first;
  assert.deepEqual(Array.from(b.renders), ['souvenirs']);
});


test('le souvenir Dazzled utilise l’animation corrigée sans modifier les autres illustrations', async () => {
  const b = browser(response);
  await b.api.loadCollection('souvenirs');
  const record = b.api.records().find(r => r.id === 'souvenir-Dazzled By The Distant Day');
  assert.equal(record.art, 'assets/images/dazzled-by-the-distant-day.webp');
  assert.ok(fs.existsSync(new URL('../../' + record.art, import.meta.url)));
  assert.ok(b.api.imageAttrs(record.art, 640).includes('src="assets/images/dazzled-by-the-distant-day.webp"'));
  for (const r of b.api.records().filter(r => r !== record)) {
    assert.equal(r.art, r.d.url_image || r.d.url_icône);
  }
});


test('les illustrations offrent des variantes adaptées et les icônes restent petites', () => {
  const b = browser(response);
  const source = memories[0].url_icône;
  const attrs = b.api.imageAttrs(source, 640, '400px');
  assert.ok(attrs.includes('w=320'));
  assert.ok(attrs.includes('w=960'));
  assert.ok(attrs.includes('q=65'));
  assert.ok(attrs.includes('sizes="400px"'));
  assert.ok(attrs.includes(encodeURIComponent(source)));
  const icon = b.api.imageAttrs(characters.find(record => record.clé_image === 'BlueSSRNaoyaArt1').url_icône, 80);
  assert.ok(icon.includes('w=40'));
  assert.ok(icon.includes('w=80'));
  assert.ok(!icon.includes('w=640'));
});

test('la première carte anime le fond du duo sans lecteur et conserve une image fixe en secours', async () => {
  const b = browser(response);
  await b.api.loadCollection('personnages');
  const [duo, next] = b.api.visibleOrder();
  assert.equal(duo.id, 'YellowSSRYujiMegumiArt1');
  const animation = duo.d['url_image_animée'];
  for (const asset of [duo.art, duo.icon, animation]) {
    assert.match(asset, /^assets\/images\//);
    assert.ok(fs.existsSync(new URL('../../' + asset, import.meta.url)));
  }
  const card = b.api.cardHTML(duo, 0);
  assert.ok(card.includes(`<picture><source media="(prefers-reduced-motion: no-preference)" type="image/webp" srcset="${animation}">`));
  assert.ok(card.includes(`src="${duo.art}" alt="" loading="eager" fetchpriority="high"`));
  assert.doesNotMatch(card, /<video/);
  assert.doesNotMatch(b.api.cardHTML(next, 1), /<picture>/);
  const webp = fs.readFileSync(new URL('../../' + animation, import.meta.url));
  const animationChunk = webp.indexOf('ANIM');
  assert.ok(animationChunk >= 0);
  assert.equal(webp.readUInt16LE(animationChunk + 12), 0);
});

test('les deux compétences tandem ont leur section, leurs niveaux et leur entrée au sommaire', async () => {
  const browserContext = browser(response);
  await browserContext.api.loadCollection('personnages');
  const [duo, other] = browserContext.api.visibleOrder();
  const { kit, toc } = browserContext.api.ficheKit(duo, '');
  const { kit: maxKit } = browserContext.api.ficheKit(duo, 'niv=10');
  assert.match(kit, /id="tandem-title"[^>]*>Compétences tandem/);
  assert.deepEqual(Array.from(kit.matchAll(/id="(sk-\d+)" data-kind="tandem"[^>]*aria-label="([^"]+)"/g), match => match.slice(1)), [
    ['sk-4', 'Tandem 1 : Fuite des lapins'], ['sk-5', 'Tandem 2 : Éléphant maximal'],
  ]);
  assert.match(toc, /data-goto="sk-4" data-kind="tandem".*data-goto="sk-5" data-kind="tandem"/);
  for (const recharge of [4, 3]) assert.ok(kit.includes(`Recharge : ${recharge} tours`));
  assert.equal((kit.match(/Jauge du duo : \+2/g) || []).length, 2);
  for (const value of ['22,09 %', '12,17 %', '88,62 %']) assert.ok(kit.includes(value));
  for (const value of ['40 %', '20 %', '150 %', '420 %']) assert.ok(maxKit.includes(value));
  assert.doesNotMatch(maxKit, /22,09 %|88,62 %/);
  for (const skill of duo.d['compétences_tandem']) {
    assert.ok(kit.includes(`src="${skill.url_icône}"`));
    assert.ok(fs.existsSync(new URL('../../' + skill.url_icône, import.meta.url)));
  }
  assert.doesNotMatch(browserContext.api.ficheKit(other, '').kit, /tandem-title/);
});

test('seules les compétences principales et tandem affichent une icône', async () => {
  const b = browser(response);
  await b.api.loadCollection('personnages');
  for (const record of b.api.records()) {
    const { kit } = b.api.ficheKit(record, '');
    const skills = record.d;
    const expected = 2 + skills.compétences.length + (skills['compétences_tandem']?.length || 0);
    assert.equal((kit.match(/<img data-skill-icon /g) || []).length, expected, record.name);
    for (const [section] of kit.matchAll(/<section class="skill"[^>]*data-kind="(?:auto|coop)"[^>]*>[\s\S]*?<\/section>/g)) {
      assert.doesNotMatch(section, /class="skill-icon"/, record.name);
    }
  }
  const naoya = b.api.records().find(record => record.id === 'BlueSSRNaoyaArt1');
  assert.match(b.api.ficheKit(naoya, '').kit, /src="https:\/\/static\.wikia\.nocookie\.net\/[^"<>]+\/BlueSSRNaoyaS11\.png\/revision\/latest"/);
});

test('les variantes modifiées affichent leur propre icône', async () => {
  const b = browser(response);
  await b.api.loadCollection('personnages');
  const mahito = b.api.records().find(record => record.id === 'RedSSRMahitoArt1');
  for (const [version, icon] of [['', 'RedSSRMahitoS21'], ['version=modifiee', 'CRedSSRMahitoS21'], ['version=modifiee2', 'CRedSSRMahitoS21C']]) {
    const { kit } = b.api.ficheKit(mahito, version);
    assert.ok(kit.includes(`src="https://cdn.jjkppdb.com/skill_icons/${icon}.png"`), version);
  }
});

test('une icône de compétence qui échoue est retirée pour laisser le symbole de secours', () => {
  const b = browser(response);
  const image = new b.HTMLImageElement();
  image.dataset = { skillIcon: '' };
  let removed = false;
  image.remove = () => { removed = true; };
  b.listeners.error({ target: image });
  assert.ok(removed);
});

test('la première illustration est prioritaire et les cartes éloignées restent différées', async () => {
  const b = browser(response);
  await b.api.loadCollection('souvenirs');
  const records = b.api.records();
  assert.ok(b.api.cardHTML(records[0], 0).includes('loading="eager" fetchpriority="high"'));
  assert.ok(b.api.cardHTML(records[5], 5).includes('loading="lazy"'));
  const corrected = records.find(r => r.id === 'souvenir-Dazzled By The Distant Day');
  assert.ok(b.api.cardHTML(corrected, 1).includes('dazzled-by-the-distant-day-480.webp 480w'));
});

test('le secours retire les variantes défaillantes avant de charger l’original', () => {
  const b = browser(response);
  const image = new b.HTMLImageElement();
  image.dataset = { originalSrc: 'original.gif' };
  const removed = [];
  image.removeAttribute = name => removed.push(name);
  image.getAttribute = () => 'optimized.webp';
  b.listeners.error({ target: image });
  assert.equal(image.src, 'original.gif');
  assert.deepEqual(removed, ['srcset', 'sizes']);
  assert.equal(image.dataset.originalSrc, undefined);
});


test('tous les GIF du catalogue sont servis intacts dans chaque taille d’affichage', () => {
  const b = browser(response);
  let checked = 0;
  for (const record of [...characters, ...memories]) {
    for (const field of ['url_image', 'url_icône']) {
      const source = record[field];
      if (!/\.gif(?:[/?#]|$)/i.test(source || '')) continue;
      for (const [width, sizes] of [[640, '400px'], [80, ''], [192, '']]) {
        const attrs = b.api.imageAttrs(source, width, sizes);
        assert.ok(!attrs.includes('/.netlify/images'), record.nom);
        assert.ok(!attrs.includes('srcset='), record.nom);
        assert.ok(!attrs.includes('data-original-src='), record.nom);
        const escaped = source.replaceAll('&', '&amp;');
        assert.equal(attrs, `src="${escaped}"`, record.nom);
      }
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('les nouveaux formats animés sont également exclus de la conversion automatique', () => {
  const b = browser(response);
  for (const filename of ['Future.GIF/revision/latest?cb=1', 'Future.gif?version=2', 'Future.webp', 'Future.apng', 'Future.avif#art']) {
    const source = 'https://static.wikia.nocookie.net/jjk-phantom-parade/images/a/ab/' + filename;
    assert.equal(b.api.imageAttrs(source, 640, '400px'), `src="${source}"`);
  }
});


test('un rendu périmé est ignoré et le dernier état est appliqué sans délai', () => {
  const b = browser(response), renders = [];
  b.api.transitionContent(() => renders.push('périmé'), () => false);
  b.api.transitionContent(() => renders.push('récent'));
  assert.deepEqual(renders, ['récent']);
});

test('la réduction des animations applique le contenu immédiatement', () => {
  const b = browser(response), renders = [];
  b.window.matchMedia = () => ({ matches: true });
  b.document.startViewTransition = () => { throw new Error('aucune transition attendue'); };
  b.api.transitionContent(() => renders.push('contenu'));
  assert.deepEqual(renders, ['contenu']);
});


test('un changement de vue pendant le chargement conserve la dernière demande', async () => {
  let release;
  const b = browser(url => url.includes('souvenirs')
    ? new Promise(resolve => { release = () => resolve(response(url)); }) : response(url));
  b.api.state.collection = 'souvenirs';
  b.location.hash = '#/?collection=souvenirs';
  const collection = b.api.onRoute();
  b.api.state.vue = 'tableau';
  const view = b.api.commitList(true);
  release();
  await Promise.all([collection, view]);
  assert.equal(b.api.state.collection, 'souvenirs');
  assert.equal(b.api.state.vue, 'tableau');
  assert.ok(b.location.hash.includes('vue=tableau'));
  assert.deepEqual(Array.from(b.renders), ['souvenirs']);
});


test('revenir à la collection chargée annule le changement encore en attente', async () => {
  let release;
  const b = browser(url => url.includes('souvenirs')
    ? new Promise(resolve => { release = () => resolve(response(url)); }) : response(url));
  await b.api.onRoute();
  b.api.state.collection = 'souvenirs';
  const pending = b.api.commitList(true);
  b.api.state.collection = 'personnages';
  b.api.commitList(true);
  assert.equal(b.renders.at(-1), 'personnages');
  const count = b.renders.length;
  release();
  await pending;
  assert.equal(b.api.state.collection, 'personnages');
  assert.equal(b.renders.length, count);
  assert.ok(!b.location.hash.includes('souvenirs'));
});


test('les niveaux des bonus de souvenirs restent séparés des pourcentages', () => {
  const b = browser(response);
  for (const level of ['Level 55', 'Lv 55', 'Lv. 55', 'Lvl 55', 'Lvl. 55', 'Niv 55', 'Niv. 55']) {
    for (const separator of [' ', '\n']) {
      assert.equal(b.api.bonusHTML(`21.97%${separator}(${level})`),
        '<span class="bonus-value">21,97%<small class="bonus-level">(Niv. 55)</small></span>');
    }
  }
  const sky = memories.find(r => r.titre === 'The Sky Is Connected');
  for (const value of Object.values(sky.bonus)) {
    assert.match(b.api.bonusHTML(value), /%<small class="bonus-level">\(Niv\. 55\)<\/small>/);
  }
});
