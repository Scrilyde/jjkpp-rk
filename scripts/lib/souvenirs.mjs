// Schéma des souvenirs affichés par le site ; les traductions inchangées sont conservées.
import { cleanWikitext, isBlank, templateParams } from './wiki.mjs';
import { normalizeDate } from './fiches.mjs';

export const MEMORY_LIST = 'SSR Memory';
export const MEMORY_TEMPLATES = ['Memory Page', 'Memory Page (Adjustment)'];

export function parseMemoryList(text) {
  const entries = new Map();
  for (const m of text.matchAll(/\[\[(?:File|Image):([^\]|]+)((?:\|[^\]]*)?)\]\]/gi)) {
    const title = /(?:^|\|)\s*link\s*=\s*([^|]+)/i.exec(m[2])?.[1].trim().replace(/_/g, ' ');
    if (title) entries.set(title, { title, icon: m[1].trim() });
  }
  return [...entries.values()];
}

const EFFECTS = [
  ['Effet actif', '', 'Effect 1', 'CD 1'],
  ['Effet actif renforcé', 'Débloqué à LB3', 'Effect 1 Lvl2', 'CD 1.2'],
  ['Effet passif', 'Débloqué à LB1', 'Effect 2', 'CD 2'],
  ['Effet actif ajusté', '', 'Post-Adjust Effect 1', 'Post-CD 1'],
  ['Effet actif renforcé ajusté', 'Débloqué à LB3', 'Post-Adjust Effect 1 Lvl2', 'Post-CD 1.2'],
  ['Effet passif ajusté', 'Débloqué à LB1', 'Post-Adjust Effect 2', 'Post-CD 2'],
];

export function buildMemory({ title, content, icon, images = {}, previous }, tr) {
  const w = templateParams(content, MEMORY_TEMPLATES);
  if (!w || cleanWikitext(w.Rarity) !== 'SSR' || isBlank(w['Effect 1']) ||
      [1, 2, 3].some(i => !(`Stat ${i}` in w) || (!isBlank(w[`Stat ${i}`]) && !/\d+(?:[.,]\d+)?\s*[%％]/.test(w[`Stat ${i}`])))) {
    throw new Error(`Fiche souvenir SSR incomplète : ${title}`);
  }
  const art = cleanWikitext(w['Card Art']) || previous?.['clé_image'] || null;
  const effects = EFFECTS.flatMap(([nom, déblocage, key, cd]) => {
    const en = cleanWikitext(w[key]);
    if (isBlank(en) || /^unchanged\.?$/i.test(en)) return [];
    const old = previous?.effets?.find(e => e.nom === nom);
    return [{ nom, déblocage, recharge: isBlank(w[cd]) ? null : cleanWikitext(w[cd]),
      effet_en: en, effet: old?.effet_en === en && old.effet ? old.effet : tr.translate(en).text }];
  });
  return {
    ...previous,
    id: previous?.id || `souvenir-${title}`,
    titre: previous?.titre || title,
    nom: previous?.nom || cleanWikitext(w['Memory Name']) || title,
    rareté: 'SSR',
    date_de_sortie: normalizeDate(w['Release Date']) || previous?.date_de_sortie || cleanWikitext(w['Release Date']),
    bonus: Object.fromEntries(['pv', 'tai', 'juj'].map((k, i) => [k, cleanWikitext(w[`Stat ${i + 1}`]).replaceAll('％', '%')])),
    effets: effects,
    clé_image: art,
    clé_icône: icon || previous?.['clé_icône'] || null,
    page_wiki: title,
    url_wiki: `https://jjk-phantom-parade.fandom.com/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/')}`,
    url_icône: images[icon] || previous?.['url_icône'] || null,
    url_image: images[art] || previous?.url_image || null,
  };
}
