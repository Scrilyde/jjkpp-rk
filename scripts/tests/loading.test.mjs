import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../../assets/app.js', import.meta.url), 'utf8');
const characters = JSON.parse(fs.readFileSync(new URL('../../data/characters.json', import.meta.url)));
const memories = JSON.parse(fs.readFileSync(new URL('../../data/souvenirs.json', import.meta.url)));

function browser(fetch) {
  const view = { setAttribute() {}, removeAttribute() {}, innerHTML: '' };
  const listeners = {};
  const context = vm.createContext({
    listeners, HTMLImageElement: class {},
    fetch, URLSearchParams, setTimeout, clearTimeout,
    location: { hash: '#/' }, history: {},
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
    renderFiche = route => renders.push(route.id);
    globalThis.api = { loadCollection, onRoute, records: () => DATA, imageAttrs, cardHTML, transitionContent };
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
  const icon = b.api.imageAttrs(characters[0].url_icône, 80);
  assert.ok(icon.includes('w=40'));
  assert.ok(icon.includes('w=80'));
  assert.ok(!icon.includes('w=640'));
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


test('une transition remplacée ne peut pas afficher un ancien état', async () => {
  const b = browser(response), callbacks = [], renders = [];
  let skipped = 0;
  b.document.startViewTransition = callback => {
    callbacks.push(callback);
    return { ready: Promise.reject(new Error('transition remplacée')), finished: Promise.resolve(), skipTransition() { skipped++; } };
  };
  const first = b.api.transitionContent(() => renders.push('ancienne'));
  const second = b.api.transitionContent(() => renders.push('récente'));
  callbacks[0](); callbacks[1]();
  await Promise.all([first, second]);
  assert.deepEqual(renders, ['récente']);
  assert.equal(skipped, 1);
});

test('la réduction des animations applique le contenu immédiatement', () => {
  const b = browser(response), renders = [];
  b.window.matchMedia = () => ({ matches: true });
  b.document.startViewTransition = () => { throw new Error('aucune transition attendue'); };
  b.api.transitionContent(() => renders.push('contenu'));
  assert.deepEqual(renders, ['contenu']);
});
