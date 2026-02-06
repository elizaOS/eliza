/**
 * D&D 5e Character System
 * Complete character sheet data model
 */

import type { AbilityScores, AbilityName } from './abilities';
import type { SkillName } from './skills';
import type { DieType } from './dice';
import type { DamageType } from './damage';
import type { ActiveCondition, ConditionName } from './conditions';

// ============================================================================
// CORE TYPES
// ============================================================================

export type Race = 
  | 'Human' | 'Dwarf' | 'Elf' | 'Halfling' | 'Dragonborn' 
  | 'Gnome' | 'Half-Elf' | 'Half-Orc' | 'Tiefling';

export type CharacterClass = 
  | 'Barbarian' | 'Bard' | 'Cleric' | 'Druid' | 'Fighter' | 'Monk' 
  | 'Paladin' | 'Ranger' | 'Rogue' | 'Sorcerer' | 'Warlock' | 'Wizard';

export type Alignment =
  | 'lawful good' | 'neutral good' | 'chaotic good'
  | 'lawful neutral' | 'true neutral' | 'chaotic neutral'
  | 'lawful evil' | 'neutral evil' | 'chaotic evil';

export type ArmorType = 'light' | 'medium' | 'heavy' | 'shield';
export type WeaponType = 'simple' | 'martial';
export type WeaponProperty = 'ammunition' | 'finesse' | 'heavy' | 'light' | 'loading' | 'reach' | 'special' | 'thrown' | 'two-handed' | 'versatile';
export type ItemRarity = 'common' | 'uncommon' | 'rare' | 'very rare' | 'legendary' | 'artifact';
export type ItemType = 'weapon' | 'armor' | 'potion' | 'scroll' | 'wand' | 'ring' | 'wondrous' | 'consumable' | 'tool' | 'gear' | 'treasure';
export type SpellSchool = 'abjuration' | 'conjuration' | 'divination' | 'enchantment' | 'evocation' | 'illusion' | 'necromancy' | 'transmutation';

// ============================================================================
// EQUIPMENT
// ============================================================================

export interface Item {
  id?: string;
  name: string;
  type: ItemType;
  rarity?: ItemRarity;
  description?: string;
  weight?: number;
  value?: number;
  quantity?: number;
  equipped?: boolean;
  attunement?: boolean;
  attuned?: boolean;
  // Weapon-specific
  damage?: string;
  damageType?: string;
  properties?: string[] | Record<string, unknown>;
  range?: string;
  // Armor-specific
  ac?: number;
  acBonus?: number;
}

export type InventoryItem = Item;

export interface Currency {
  copper?: number;
  silver?: number;
  electrum?: number;
  gold?: number;
  platinum?: number;
  // Short aliases
  cp?: number;
  sp?: number;
  ep?: number;
  gp?: number;
  pp?: number;
}

// ============================================================================
// SPELLCASTING
// ============================================================================

export interface Spell {
  id?: string;
  name: string;
  level: number;
  school: SpellSchool | string;
  castingTime: string;
  range: string;
  components?: { verbal: boolean; somatic: boolean; material?: string };
  duration?: string;
  concentration?: boolean;
  ritual?: boolean;
  description?: string;
  higherLevels?: string;
  damage?: string;
  damageType?: DamageType | string;
  healing?: string;
  attack?: boolean;
  savingThrow?: AbilityName | string;
  attackType?: 'melee' | 'ranged';
}

// ============================================================================
// COMBAT STATS
// ============================================================================

export interface HitPoints {
  current: number;
  max: number;
  temporary?: number;
  temp?: number; // Alias
}

export interface HitDice {
  current: number;
  max: number;
  type?: DieType;
}

export interface DeathSaves {
  successes: number;
  failures: number;
}

// ============================================================================
// PROFICIENCIES & PERSONALITY
// ============================================================================

export interface Proficiencies {
  savingThrows?: AbilityName[] | string[];
  skills?: SkillName[] | string[];
  armor?: string[];
  weapons?: string[];
  tools?: string[];
  languages?: string[];
}

export interface Personality {
  traits?: string[];
  ideals?: string;
  bonds?: string;
  flaws?: string;
  backstory?: string;
}

// ============================================================================
// ABILITY SCORES (flexible format)
// ============================================================================

export interface AbilityWithModifier {
  score: number;
  modifier: number;
}

export type FlexibleAbilities = AbilityScores | {
  strength: AbilityWithModifier | number;
  dexterity: AbilityWithModifier | number;
  constitution: AbilityWithModifier | number;
  intelligence: AbilityWithModifier | number;
  wisdom: AbilityWithModifier | number;
  charisma: AbilityWithModifier | number;
};

// ============================================================================
// EQUIPMENT (flexible format)
// ============================================================================

export interface EquipmentSet {
  weapons?: Item[];
  armor?: Item;
  shield?: Item;
  inventory?: Item[];
  currency?: Currency;
}

// ============================================================================
// CHARACTER SHEET
// ============================================================================

export interface CharacterSheet {
  // Identity
  id?: string;
  campaignId?: string;
  name: string;
  race: Race | string;
  subrace?: string;
  class: CharacterClass | string;
  subclass?: string;
  level: number;
  experiencePoints?: number;
  background?: string;
  alignment?: Alignment | string;
  
  // Abilities
  abilities: FlexibleAbilities;
  
  // Combat Stats
  armorClass?: number;
  ac?: number;
  initiative?: number;
  speed?: number;
  hp?: HitPoints;
  hitPoints?: HitPoints;
  hitDice?: HitDice;
  deathSaves?: DeathSaves;
  proficiencyBonus?: number;
  
  // Proficiencies & Skills
  proficiencies?: Proficiencies;
  expertise?: string[];
  savingThrows?: string[];
  skills?: Record<string, number>;
  
  // Equipment
  equipment?: Item[] | EquipmentSet;
  currency?: Currency;
  
  // Features
  features?: string[];
  racialTraits?: string[];
  
  // Spellcasting
  spellSlots?: Record<number, { max: number; current: number }>;
  spellsKnown?: Spell[];
  spellsPrepared?: string[];
  cantrips?: Spell[];
  spellcastingAbility?: AbilityName | string;
  concentratingOn?: string;
  
  // Personality
  personality?: Personality;
  backstory?: string;
  
  // Status Effects
  conditions?: ActiveCondition[];
  resistances?: DamageType[];
  immunities?: DamageType[];
  vulnerabilities?: DamageType[];
  conditionImmunities?: ConditionName[];
  
  // Visual
  portraitUrl?: string;
  tokenUrl?: string;
  
  // Meta
  isAI?: boolean;
  agentId?: string;
  playerId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

// ============================================================================
// HELPER TYPES
// ============================================================================

export interface CharacterPosition {
  x: number;
  y: number;
}

export interface CharacterCombatState {
  characterId: string;
  initiative: number;
  hasActed: boolean;
  hasUsedBonusAction: boolean;
  hasUsedReaction: boolean;
  movementRemaining: number;
  position: CharacterPosition;
}

export interface CalculatedStats {
  abilityModifiers: Record<AbilityName, number>;
  savingThrows: Record<AbilityName, number>;
  skills: Record<SkillName, number>;
  passivePerception: number;
  passiveInsight: number;
  passiveInvestigation: number;
  attackBonus: { melee: number; ranged: number; spell: number };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/** Get AC from character (handles both field names) */
export function getAC(char: CharacterSheet): number {
  return char.ac ?? char.armorClass ?? 10;
}

/** Get HP from character (handles both field names) */
export function getHP(char: CharacterSheet): HitPoints {
  const hp = char.hp ?? char.hitPoints;
  if (!hp) return { current: 1, max: 1, temporary: 0 };
  return { current: hp.current, max: hp.max, temporary: hp.temporary ?? hp.temp ?? 0 };
}

/** Get ability modifier from score */
export function getAbilityMod(score: number | AbilityWithModifier): number {
  if (typeof score === 'object') return score.modifier;
  return Math.floor((score - 10) / 2);
}

/** Get ability score */
export function getAbilityScore(value: number | AbilityWithModifier): number {
  return typeof value === 'object' ? value.score : value;
}
