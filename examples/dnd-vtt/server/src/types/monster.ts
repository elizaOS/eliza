/**
 * D&D 5e Monster System
 * Monster stat blocks and NPC definitions
 */

import type { DamageType } from './damage';
import type { ActiveCondition, ConditionName } from './conditions';

// ============================================================================
// MONSTER TYPES
// ============================================================================

export type MonsterType =
  | 'aberration'
  | 'beast'
  | 'celestial'
  | 'construct'
  | 'dragon'
  | 'elemental'
  | 'fey'
  | 'fiend'
  | 'giant'
  | 'humanoid'
  | 'monstrosity'
  | 'ooze'
  | 'plant'
  | 'undead';

export type Size = 'Tiny' | 'Small' | 'Medium' | 'Large' | 'Huge' | 'Gargantuan';
export type Alignment = 
  | 'lawful good' | 'neutral good' | 'chaotic good'
  | 'lawful neutral' | 'true neutral' | 'chaotic neutral'
  | 'lawful evil' | 'neutral evil' | 'chaotic evil'
  | 'unaligned' | 'any alignment';

// ============================================================================
// MONSTER ABILITIES
// ============================================================================

export interface MonsterAbilities {
  str: number;
  dex: number;
  con: number;
  int: number;
  wis: number;
  cha: number;
}

// ============================================================================
// MONSTER SPEED
// ============================================================================

export interface MonsterSpeed {
  walk: number;
  burrow?: number;
  climb?: number;
  fly?: number;
  hover?: boolean;
  swim?: number;
}

// ============================================================================
// MONSTER SENSES
// ============================================================================

export interface MonsterSenses {
  blindsight?: number;
  darkvision?: number;
  tremorsense?: number;
  truesight?: number;
  passivePerception?: number;
}

// ============================================================================
// MONSTER ACTIONS
// ============================================================================

export interface MonsterAction {
  name: string;
  description: string;
  attackBonus?: number;
  damage?: string;
  damageType?: DamageType;
  reach?: number;
  range?: string;
  recharge?: string;
  saveDC?: number;
  saveAbility?: string;
  usesPerDay?: number;
  currentUses?: number;
}

export interface MonsterTrait {
  name: string;
  description: string;
}

export interface LegendaryAction {
  name: string;
  description: string;
  cost: number;
}

export interface Reaction {
  name: string;
  description: string;
  trigger: string;
}

// ============================================================================
// MONSTER STAT BLOCK
// ============================================================================

export interface Monster {
  // Identity
  id: string;
  name: string;
  size: Size;
  type: MonsterType;
  subtype?: string;
  alignment: Alignment;
  
  // Combat Stats
  ac: number;
  armorType?: string;
  hp: {
    current: number;
    max: number;
    temp: number;
  };
  hpFormula?: string;
  speed: MonsterSpeed;
  
  // Ability Scores
  abilities: MonsterAbilities;
  
  // Proficiencies
  savingThrows?: Partial<Record<'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha', number>>;
  skills?: Record<string, number>;
  
  // Damage Modifiers
  resistances?: DamageType[];
  immunities?: DamageType[];
  vulnerabilities?: DamageType[];
  conditionImmunities?: ConditionName[];
  
  // Senses & Languages
  senses: MonsterSenses;
  languages: string[];
  telepathy?: number;
  
  // Challenge
  challengeRating: number;
  experiencePoints?: number;
  proficiencyBonus?: number;
  
  // Abilities
  specialAbilities?: MonsterTrait[];
  actions: MonsterAction[];
  bonusActions?: MonsterAction[];
  reactions?: Reaction[];
  legendaryActions?: {
    description: string;
    actionsPerRound: number;
    actions: LegendaryAction[];
  };
  lairActions?: {
    description: string;
    actions: string[];
  };
  
  // Runtime status
  conditions?: ActiveCondition[];
  legendaryActionsRemaining?: number;
  
  // Visual
  imageUrl?: string;
  tokenUrl?: string;
  
  // Meta
  source?: string;
  page?: number;
}

// ============================================================================
// NPC (Non-Player Character)
// ============================================================================

export interface NPC {
  id?: string;
  campaignId?: string;
  name: string;
  type: 'ally' | 'enemy' | 'neutral' | 'merchant' | 'questGiver' | 'quest_giver' | 'informant' | 'other' | string;
  
  // Description
  race?: string;
  occupation?: string;
  description?: string;
  personality?: string;
  appearance?: string;
  motivation?: string;
  
  // Location
  currentLocationId?: string;
  
  // Relationships
  partyDisposition?: number; // -100 to 100
  isAlive?: boolean;
  isHostile?: boolean;
  secrets?: string[];
  
  // Interaction tracking
  interactionCount?: number;
  lastInteraction?: Date;
  
  // Combat (optional - can be direct stats or full stat block)
  statBlock?: Monster;
  hp?: { current: number; max: number; temp: number };
  ac?: number;
  challengeRating?: number;
  
  // Visual
  portraitUrl?: string;
}

// ============================================================================
// ENCOUNTER
// ============================================================================

export interface EncounterMonster {
  monsterId: string;
  instanceId: string;
  name: string;
  monster: Monster;
  position: { x: number; y: number };
}

export interface Encounter {
  id: string;
  name: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard' | 'deadly';
  monsters: EncounterMonster[];
  totalXP: number;
  environmentNotes?: string;
  tactics?: string;
  treasure?: string;
}

// ============================================================================
// CHALLENGE RATING CALCULATIONS
// ============================================================================

export const CR_TO_XP: Record<number | string, number> = {
  0: 10,
  0.125: 25,
  0.25: 50,
  0.5: 100,
  1: 200,
  2: 450,
  3: 700,
  4: 1100,
  5: 1800,
  6: 2300,
  7: 2900,
  8: 3900,
  9: 5000,
  10: 5900,
  11: 7200,
  12: 8400,
  13: 10000,
  14: 11500,
  15: 13000,
  16: 15000,
  17: 18000,
  18: 20000,
  19: 22000,
  20: 25000,
  21: 33000,
  22: 41000,
  23: 50000,
  24: 62000,
  25: 75000,
  26: 90000,
  27: 105000,
  28: 120000,
  29: 135000,
  30: 155000,
};

export const CR_TO_PROFICIENCY: Record<number, number> = {
  0: 2, 1: 2, 2: 2, 3: 2, 4: 2,
  5: 3, 6: 3, 7: 3, 8: 3,
  9: 4, 10: 4, 11: 4, 12: 4,
  13: 5, 14: 5, 15: 5, 16: 5,
  17: 6, 18: 6, 19: 6, 20: 6,
  21: 7, 22: 7, 23: 7, 24: 7,
  25: 8, 26: 8, 27: 8, 28: 8,
  29: 9, 30: 9,
};

/**
 * Calculate encounter difficulty thresholds for a party
 */
export function calculateEncounterThresholds(
  partyLevels: number[]
): { easy: number; medium: number; hard: number; deadly: number } {
  const thresholds = { easy: 0, medium: 0, hard: 0, deadly: 0 };
  
  const XP_BY_LEVEL: Record<number, { easy: number; medium: number; hard: number; deadly: number }> = {
    1: { easy: 25, medium: 50, hard: 75, deadly: 100 },
    2: { easy: 50, medium: 100, hard: 150, deadly: 200 },
    3: { easy: 75, medium: 150, hard: 225, deadly: 400 },
    4: { easy: 125, medium: 250, hard: 375, deadly: 500 },
    5: { easy: 250, medium: 500, hard: 750, deadly: 1100 },
    6: { easy: 300, medium: 600, hard: 900, deadly: 1400 },
    7: { easy: 350, medium: 750, hard: 1100, deadly: 1700 },
    8: { easy: 450, medium: 900, hard: 1400, deadly: 2100 },
    9: { easy: 550, medium: 1100, hard: 1600, deadly: 2400 },
    10: { easy: 600, medium: 1200, hard: 1900, deadly: 2800 },
    11: { easy: 800, medium: 1600, hard: 2400, deadly: 3600 },
    12: { easy: 1000, medium: 2000, hard: 3000, deadly: 4500 },
    13: { easy: 1100, medium: 2200, hard: 3400, deadly: 5100 },
    14: { easy: 1250, medium: 2500, hard: 3800, deadly: 5700 },
    15: { easy: 1400, medium: 2800, hard: 4300, deadly: 6400 },
    16: { easy: 1600, medium: 3200, hard: 4800, deadly: 7200 },
    17: { easy: 2000, medium: 3900, hard: 5900, deadly: 8800 },
    18: { easy: 2100, medium: 4200, hard: 6300, deadly: 9500 },
    19: { easy: 2400, medium: 4900, hard: 7300, deadly: 10900 },
    20: { easy: 2800, medium: 5700, hard: 8500, deadly: 12700 },
  };
  
  for (const level of partyLevels) {
    const levelThresholds = XP_BY_LEVEL[Math.min(level, 20)] || XP_BY_LEVEL[20];
    thresholds.easy += levelThresholds.easy;
    thresholds.medium += levelThresholds.medium;
    thresholds.hard += levelThresholds.hard;
    thresholds.deadly += levelThresholds.deadly;
  }
  
  return thresholds;
}

/**
 * Calculate adjusted XP for encounter difficulty
 * Based on number of monsters (multiplier)
 */
export function calculateAdjustedXP(
  totalXP: number,
  monsterCount: number,
  partySize: number
): number {
  let multiplier = 1;
  
  if (monsterCount === 2) multiplier = 1.5;
  else if (monsterCount >= 3 && monsterCount <= 6) multiplier = 2;
  else if (monsterCount >= 7 && monsterCount <= 10) multiplier = 2.5;
  else if (monsterCount >= 11 && monsterCount <= 14) multiplier = 3;
  else if (monsterCount >= 15) multiplier = 4;
  
  // Adjust for party size
  if (partySize < 3) multiplier += 0.5;
  else if (partySize >= 6) multiplier -= 0.5;
  
  return Math.floor(totalXP * multiplier);
}

/**
 * Get XP value for a challenge rating
 */
export function getXPForCR(cr: number): number {
  return CR_TO_XP[cr] || CR_TO_XP[0];
}

/**
 * Get proficiency bonus for a challenge rating
 */
export function getProficiencyForCR(cr: number): number {
  return CR_TO_PROFICIENCY[Math.floor(cr)] || 2;
}
