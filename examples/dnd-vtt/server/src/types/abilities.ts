/**
 * D&D 5e Ability Score System
 * Core ability definitions and calculations per SRD
 */

export type AbilityName = 
  | 'strength'
  | 'dexterity'
  | 'constitution'
  | 'intelligence'
  | 'wisdom'
  | 'charisma';

export const ABILITY_NAMES: AbilityName[] = [
  'strength',
  'dexterity',
  'constitution',
  'intelligence',
  'wisdom',
  'charisma',
];

export const ABILITY_ABBREVIATIONS: Record<AbilityName, string> = {
  strength: 'STR',
  dexterity: 'DEX',
  constitution: 'CON',
  intelligence: 'INT',
  wisdom: 'WIS',
  charisma: 'CHA',
};

export interface AbilityScores {
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  wisdom: number;
  charisma: number;
}

export interface AbilityModifiers {
  strength: number;
  dexterity: number;
  constitution: number;
  intelligence: number;
  wisdom: number;
  charisma: number;
}

/**
 * Calculate ability modifier from ability score
 * Formula: floor((score - 10) / 2)
 */
export function calculateModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/**
 * Calculate all ability modifiers from scores
 */
export function calculateAllModifiers(scores: AbilityScores): AbilityModifiers {
  return {
    strength: calculateModifier(scores.strength),
    dexterity: calculateModifier(scores.dexterity),
    constitution: calculateModifier(scores.constitution),
    intelligence: calculateModifier(scores.intelligence),
    wisdom: calculateModifier(scores.wisdom),
    charisma: calculateModifier(scores.charisma),
  };
}

/**
 * Proficiency bonus by character level
 * Level 1-4: +2
 * Level 5-8: +3
 * Level 9-12: +4
 * Level 13-16: +5
 * Level 17-20: +6
 */
export function getProficiencyBonus(level: number): number {
  if (level < 1) return 2;
  if (level <= 4) return 2;
  if (level <= 8) return 3;
  if (level <= 12) return 4;
  if (level <= 16) return 5;
  return 6;
}

/**
 * Standard array for ability score generation
 */
export const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];

/**
 * Point buy costs for ability scores
 */
export const POINT_BUY_COSTS: Record<number, number> = {
  8: 0,
  9: 1,
  10: 2,
  11: 3,
  12: 4,
  13: 5,
  14: 7,
  15: 9,
};

export const POINT_BUY_BUDGET = 27;
