import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemory, parseMemoryList } from '../lib/souvenirs.mjs';

const content = '{{Memory Page (Adjustment)|Memory Name=Pride|Rarity=SSR|Card Art=PrideArt|Release Date=1-2-2026|Stat 1=13.30%<br>(Level 55)|Stat 2=0%|Stat 3=39.90%|Effect 1=Old effect|CD 1=5|Effect 1 Lvl2=Stronger|CD 1.2=6|Effect 2=Passive|CD 2=/|Post-Adjust Effect 1=New effect|Post-CD 1=4|Post-Adjust Effect 2=Unchanged}}';
const translator = { translate: text => ({ text: 'FR: ' + text }) };

test('la liste déduplique les liens et conserve les noms de fichiers exacts', () => {
  assert.deepEqual(parseMemoryList('[[File:Pride.png|100px|link=Pride]] [[File:Other.jpg|link=Other_Memory|thumb]] [[File:Pride.png|link=Pride]] [[File:Ignore.png|thumb]]'), [
    { title: 'Pride', icon: 'Pride.png' }, { title: 'Other Memory', icon: 'Other.jpg' },
  ]);
});

test('bonus, effets ajustés, recharge et déblocages suivent le schéma du site', () => {
  const m = buildMemory({ title: 'Pride', content, icon: 'Pride.png', images: { PrideArt: 'art.gif', 'Pride.png': 'icon.png' } }, translator);
  assert.equal(m.bonus.pv, '13.30%\n(Level 55)');
  assert.equal(m.date_de_sortie, '01-02-2026');
  assert.equal(m.effets.length, 4);
  assert.equal(m.effets[1].déblocage, 'Débloqué à LB3');
  assert.equal(m.effets[2].recharge, null);
  assert.equal(m.effets[3].recharge, '4');
  assert.equal(m.effets[3].effet, 'FR: New effect');
  assert.equal(m.url_image, 'art.gif');
});

test('une traduction manuelle inchangée et les URL de secours sont conservées', () => {
  const previous = { id: 'stable-id', nom: 'Fierté', url_image: 'old.gif', url_icône: 'old.png', effets: [{ nom: 'Effet actif', effet_en: 'Old effect', effet: 'Traduction manuelle' }] };
  const m = buildMemory({ title: 'Renamed Pride', content, previous }, translator);
  assert.equal(m.id, 'stable-id');
  assert.equal(m.nom, 'Fierté');
  assert.equal(m.effets[0].effet, 'Traduction manuelle');
  assert.equal(m.effets[1].effet, 'FR: Stronger');
  assert.equal(m.url_image, 'old.gif');
  assert.equal(m.url_icône, 'old.png');
});

test('les fiches incomplètes ou hors SSR interrompent la synchronisation', () => {
  for (const text of ['', content.replace('Rarity=SSR', 'Rarity=SR'), content.replace('Stat 2=0%', 'Stat 2=???')]) {
    assert.throws(() => buildMemory({ title: 'Pride', content: text }, translator), /incomplète/);
  }
});

test('les valeurs N/A et les pourcentages pleine chasse du wiki sont acceptés', () => {
  const m = buildMemory({ title: 'Pride', content: content.replace('Stat 2=0%', 'Stat 2=N/A').replace('Stat 3=39.90%', 'Stat 3=39.90％') }, translator);
  assert.equal(m.bonus.tai, 'N/A');
  assert.equal(m.bonus.juj, '39.90%');
});
