/**
 * SRD (System Reference Document) monster data and helpers
 * Minimal set for starter content and combat
 */

import { v4 as uuid } from 'uuid';
import type { Monster, MonsterAction } from './types';

const goblinActions: MonsterAction[] = [
  {
    name: 'Scimitar',
    description: 'Melee Weapon Attack',
    attackBonus: 4,
    damage: '1d6 + 2',
    damageType: 'slashing',
    reach: 5,
  },
  {
    name: 'Shortbow',
    description: 'Ranged Weapon Attack',
    attackBonus: 4,
    damage: '1d6 + 2',
    damageType: 'piercing',
    range: '80/320',
  },
];

/** SRD monster templates keyed by monster id (lowercase) */
export const SRD_MONSTERS: Record<string, Monster> = {
  goblin: {
    id: 'srd-goblin',
    name: 'Goblin',
    size: 'Small',
    type: 'humanoid',
    alignment: 'neutral evil',
    ac: 15,
    armorType: 'leather armor, shield',
    hp: { current: 7, max: 7, temp: 0 },
    hpFormula: '2d6',
    speed: { walk: 30 },
    abilities: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
    senses: { darkvision: 60, passivePerception: 9 },
    languages: ['Common', 'Goblin'],
    challengeRating: 0.25,
    experiencePoints: 50,
    proficiencyBonus: 2,
    actions: goblinActions,
    specialAbilities: [
      {
        name: 'Nimble Escape',
        description: 'The goblin can take the Disengage or Hide action as a bonus action on each of its turns.',
      },
    ],
  },
};

/**
 * Clone a monster template with a new id and name for use as an instance in combat
 */
export function cloneMonster(template: Monster, name: string): Monster {
  return {
    ...template,
    id: uuid(),
    name,
    hp: {
      current: template.hp.max,
      max: template.hp.max,
      temp: 0,
    },
  };
}
