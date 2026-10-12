// Accès au wiki Fandom (API MediaWiki) et lecture du wikitext. Aucune dépendance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WIKI = 'https://jjk-phantom-parade.fandom.com';
export const API = `${WIKI}/api.php`;
export const USER_AGENT = 'JJKPP-RK-sync/1.0 (+https://github.com/Scrilyde/jjkpp-rk)';
export const CHARACTER_TEMPLATES = ['Character Page', 'Character Page (Adjustment)'];
export const LIST_PAGES = ['SSR Character', 'SR Character', 'R Character'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Client poli : User-Agent identifiable, pause entre les appels, maxlag, nouvelles tentatives espacées.
// `cacheDir` (développement uniquement) rejoue les réponses déjà obtenues au lieu de rappeler le wiki.
export function createClient({ pauseMs = 1000, cacheDir = null, log = () => {} } = {}) {
  let last = 0, calls = 0;
  async function api(params) {
    const query = new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params });
    const url = `${API}?${query}`;
    const cacheFile = cacheDir && path.join(cacheDir, crypto.createHash('sha1').update(url).digest('hex') + '.json');
    if (cacheFile && fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    for (let attempt = 1; ; attempt++) {
      const wait = last + pauseMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now(); calls++;
      let res, body;
      try {
        res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
        body = res.ok ? await res.json() : null;
      } catch (error) { res = { status: 0, statusText: error.message }; }
      const lagged = body?.error?.code === 'maxlag';
      if (res.ok && body && !lagged) {
        if (body.error) throw new Error(`API ${body.error.code} : ${body.error.info}`);
        if (cacheFile) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify(body)); }
        return body;
      }
      const retryable = lagged || res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= 5) throw new Error(`Échec de l'appel API (${res.status} ${res.statusText || ''}) : ${url}`);
      const delay = Math.min(60000, 5000 * 2 ** (attempt - 1));
      log(`  réessai ${attempt}/4 dans ${delay / 1000} s (${lagged ? 'maxlag' : res.status})`);
      await sleep(delay);
    }
  }
  return { api, get calls() { return calls; } };
}

const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

// Pages de l'espace principal qui utilisent l'un des modèles de fiche.
export async function listCharacterPages(client) {
  const titles = new Set();
  for (const tpl of CHARACTER_TEMPLATES) {
    let cont = {};
    while (cont) {
      const j = await client.api({ action: 'query', list: 'embeddedin', eititle: `Template:${tpl}`, einamespace: '0', eilimit: '500', ...cont });
      j.query.embeddedin.forEach(p => titles.add(p.title));
      cont = j.continue || null;
    }
  }
  return [...titles].sort();
}

// Wikitext courant de plusieurs pages, par lots de 50 titres.
export async function fetchWikitext(client, titles) {
  const out = {};
  for (const batch of chunks(titles, 50)) {
    const j = await client.api({ action: 'query', prop: 'revisions', rvprop: 'content|ids|timestamp', rvslots: 'main', titles: batch.join('|') });
    for (const p of j.query.pages) {
      if (p.missing || !p.revisions) continue;
      out[p.title] = { revid: p.revisions[0].revid, timestamp: p.revisions[0].timestamp, content: p.revisions[0].slots.main.content };
    }
  }
  return out;
}

// Titre canonique (normalisation + redirections) et existence de chaque titre demandé.
export async function resolveTitles(client, titles) {
  const out = {};
  for (const batch of chunks([...new Set(titles)], 50)) {
    const j = await client.api({ action: 'query', redirects: '1', titles: batch.join('|') });
    const norm = Object.fromEntries((j.query.normalized || []).map(n => [n.from, n.to]));
    const red = Object.fromEntries((j.query.redirects || []).map(n => [n.from, n.to]));
    const exists = new Set(j.query.pages.filter(p => !p.missing && !p.invalid).map(p => p.title));
    for (const t of batch) {
      const canonical = red[norm[t] || t] || norm[t] || t;
      out[t] = { title: canonical, exists: exists.has(canonical) };
    }
  }
  return out;
}

// URL des fichiers d'image (prop=imageinfo). `names` sans préfixe « File: ».
export async function fetchImageUrls(client, names) {
  const out = {};
  for (const batch of chunks([...new Set(names)], 50)) {
    const j = await client.api({ action: 'query', prop: 'imageinfo', iiprop: 'url', titles: batch.map(n => `File:${n}`).join('|') });
    const norm = Object.fromEntries((j.query.normalized || []).map(n => [n.to, n.from]));
    for (const p of j.query.pages) {
      const url = p.imageinfo?.[0]?.url;
      if (url) out[(norm[p.title] || p.title).replace(/^File:/, '')] = url;
    }
  }
  return out;
}

// Tout ce que la synchro lit sur le wiki : fiches (paramètres du modèle), listes SSR/SR/R, titres résolus.
// `extraTitles` : titres à résoudre en plus de ceux des listes (page_wiki, url_wiki des fiches).
export async function loadWiki(client, extraTitles = []) {
  const pages = await fetchWikitext(client, await listCharacterPages(client));
  const lists = await fetchWikitext(client, LIST_PAGES);
  const listEntries = parseCharacterLists(Object.fromEntries(Object.entries(lists).map(([t, p]) => [t, p.content])));
  const wikiParams = {};
  for (const [t, p] of Object.entries(pages)) { const w = templateParams(p.content, CHARACTER_TEMPLATES); if (w) wikiParams[t] = w; }
  const resolved = await resolveTitles(client, [...listEntries.map(e => e.title), ...extraTitles]);
  return { pages, wikiParams, listEntries, resolved };
}

// Paramètres nommés du premier appel à l'un des modèles `names` (gère {{…}} et [[…]] imbriqués).
export function templateParams(text, names) {
  const alternatives = names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[ _]')).join('|');
  const m = new RegExp(`\\{\\{\\s*(?:${alternatives})\\s*\\|`).exec(text);
  if (!m) return null;
  const parts = []; let depth = 0, cur = '';
  for (let i = m.index + 2; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '{{' || two === '[[') { depth++; cur += two; i++; continue; }
    if (two === '}}' && depth === 0) { parts.push(cur); break; }
    if (two === '}}' || two === ']]') { depth--; cur += two; i++; continue; }
    if (text[i] === '|' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += text[i];
  }
  const params = {};
  for (const p of parts.slice(1)) {
    const k = p.indexOf('=');
    if (k > 0) params[p.slice(0, k).trim()] = p.slice(k + 1).trim();
  }
  return params;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };

// Wikitext d'un paramètre → texte brut (sauts de ligne pour <br>).
export function cleanWikitext(value) {
  if (value == null) return '';
  let s = String(value)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\[\[(?:File|Image|Fichier):[^\]]*\]\]/gi, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/'''''|'''|''/g, '')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => e[0] === '#'
      ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
      : ENTITIES[e.toLowerCase()] ?? all);
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n').replace(/^\n+|\n+$/g, '');
  return s;
}

// Valeur vide au sens du wiki (« N/A », « / », vide).
export const isBlank = v => v == null || /^\s*(?:N\/A|\/|-|—)?\s*$/i.test(String(v));

// Entrées des pages de liste SSR/SR/R : titre lié, clé d'icône (UnitN), type et rareté.
export function parseCharacterLists(listTexts) {
  const entries = [];
  for (const [page, text] of Object.entries(listTexts)) {
    const rarity = page.split(' ')[0];
    for (const m of text.matchAll(/\{\{\s*Character List\s*\|([\s\S]*?)\}\}/g)) {
      const kv = {};
      for (const part of m[1].split('|')) {
        const k = part.indexOf('=');
        if (k > 0) kv[part.slice(0, k).trim()] = part.slice(k + 1).trim();
      }
      for (const [k, title] of Object.entries(kv)) {
        const n = /^Character Link (\d+)$/.exec(k);
        if (n && title) entries.push({ title, unit: kv[`Unit${n[1]}`] || null, type: kv.Type || null, rarity });
      }
    }
  }
  return entries;
}
