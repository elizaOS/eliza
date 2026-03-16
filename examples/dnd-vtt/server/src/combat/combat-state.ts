/**
 * Combat State Types
 * Core data structures for combat encounters
 */

import type { 
  ConditionName, 
  ActiveCondition,
  CharacterSheet,
  Monster,
  DamageType,
} from '../types';
import { getAbilityMod, getConditionName } from '../types';

/**
 * A participant in combat
 */
export interface Combatant {
  id: string;
  name: string;
  type: 'pc' | 'npc' | 'monster';
  
  // Initiative
  initiative: number;
  dexterityModifier: number;
  wisdomModifier: number;
  constitutionModifier: number;
  
  // Combat stats
  hp: {
    current: number;
    max: number;
    temp: number;
  };
  ac: number;
  speed: number;
  
  // Position on battle map (if using grid)
  position?: {
    x: number;
    y: number;
  };
  
  // Conditions and effects
  conditions: ActiveCondition[];
  concentratingOn?: string; // Spell name
  
  // Death saves (for PCs)
  deathSaves?: {
    successes: number;
    failures: number;
  };
  
  // Resources used this turn
  turnResources: {
    actionUsed: boolean;
    bonusActionUsed: boolean;
    reactionUsed: boolean;
    movementRemaining: number;
    freeObjectInteraction: boolean;
  };
  
  // Reference to full character/monster data
  sourceId: string;
  sourceType: 'character' | 'monster';
  
  // Resistances/immunities for damage calculation
  resistances?: DamageType[];
  immunities?: DamageType[];
  vulnerabilities?: DamageType[];
  
  // XP value (for monsters)
  experiencePoints?: number;
}

/**
 * A single combat encounter
 */
export interface CombatEncounter {
  id: string;
  campaignId: string;
  sessionId: string;
  
  // Battle map reference
  battleMapId?: string;
  
  // Combat status
  status: 'preparing' | 'active' | 'paused' | 'ended';
  round: number;
  currentTurnIndex: number;
  
  // Participants
  initiativeOrder: Combatant[];
  defeatedCombatants: Combatant[];
  fledCombatants: Combatant[];
  
  // Environment
  environmentalEffects: EnvironmentalEffect[];
  lightingCondition: 'bright' | 'dim' | 'darkness';
  
  // Lair actions (if fighting in a lair)
  lairActionsAvailable: boolean;
  lairActionUsedThisRound: boolean;
  
  // Legendary actions tracking
  legendaryActionsRemaining: Map<string, number>;
  
  // Combat log
  actionLog: CombatLogEntry[];
  
  // Timestamps
  startedAt: Date;
  endedAt?: Date;
}

/**
 * Environmental effects that impact combat
 */
export interface EnvironmentalEffect {
  id: string;
  name: string;
  description: string;
  affectedArea?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  effect: {
    damagePerRound?: {
      amount: string; // e.g., "1d6"
      type: DamageType;
    };
    conditionApplied?: ConditionName;
    movementModifier?: number; // Multiplier (0.5 for difficult terrain)
    coverBonus?: number;
  };
  savingThrow?: {
    ability: 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
    dc: number;
    effectOnSave: 'negates' | 'half_damage';
  };
  duration: {
    type: 'rounds' | 'indefinite';
    remaining?: number;
  };
}

/**
 * Log entry for combat actions
 */
export interface CombatLogEntry {
  timestamp: Date;
  round: number;
  turnOrder: number;
  
  actorId: string;
  actorName: string;
  
  actionType: CombatActionType;
  actionDescription: string;
  
  targetIds?: string[];
  targetNames?: string[];
  
  diceRolls?: DiceRollResult[];
  
  damage?: {
    amount: number;
    type: DamageType;
    wasCritical: boolean;
  };
  
  healing?: number;
  
  conditionsApplied?: ConditionName[];
  conditionsRemoved?: ConditionName[];
  
  outcome: string;
}

/**
 * Types of combat actions
 */
export type CombatActionType =
  | 'attack'
  | 'cast_spell'
  | 'dash'
  | 'disengage'
  | 'dodge'
  | 'help'
  | 'hide'
  | 'ready'
  | 'search'
  | 'use_object'
  | 'grapple'
  | 'shove'
  | 'bonus_action'
  | 'reaction'
  | 'movement'
  | 'free_action'
  | 'legendary_action'
  | 'lair_action'
  | 'environmental'
  | 'death_save'
  | 'stabilize';

/**
 * Result of a dice roll
 */
export interface DiceRollResult {
  type: string; // e.g., "attack", "damage", "saving_throw"
  dice: string; // e.g., "1d20", "2d6"
  rolls: number[];
  modifier: number;
  total: number;
  advantage?: boolean;
  disadvantage?: boolean;
  droppedRolls?: number[];
}

/**
 * Create a combatant from a character sheet
 */
export function createCombatantFromCharacter(
  character: CharacterSheet,
  initiative: number
): Combatant {
  const hp = character.hp ?? character.hitPoints;
  const ac = character.ac ?? character.armorClass ?? 10;
  const speed = character.speed ?? 30;
  const charId = character.id ?? `char-${character.name}`;

  return {
    id: `combat-${charId}`,
    name: character.name,
    type: 'pc', // All party members are PCs
    initiative,
    dexterityModifier: getAbilityMod(character.abilities.dexterity),
    wisdomModifier: getAbilityMod(character.abilities.wisdom),
    constitutionModifier: getAbilityMod(character.abilities.constitution),
    hp: {
      current: hp?.current ?? 1,
      max: hp?.max ?? 1,
      temp: hp?.temporary ?? hp?.temp ?? 0,
    },
    ac,
    speed,
    position: undefined,
    conditions: character.conditions ? [...character.conditions] : [],
    concentratingOn: undefined,
    deathSaves: {
      successes: 0,
      failures: 0,
    },
    turnResources: {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementRemaining: speed,
      freeObjectInteraction: true,
    },
    sourceId: charId,
    sourceType: 'character',
    resistances: character.resistances,
    immunities: character.immunities,
    vulnerabilities: character.vulnerabilities,
  };
}

/**
 * Create a combatant from a monster
 */
export function createCombatantFromMonster(
  monster: Monster,
  initiative: number,
  instanceNumber?: number
): Combatant {
  const suffix = instanceNumber !== undefined ? ` ${instanceNumber + 1}` : '';
  
  return {
    id: `combat-${monster.id}${instanceNumber !== undefined ? `-${instanceNumber}` : ''}`,
    name: `${monster.name}${suffix}`,
    type: 'monster',
    initiative,
    dexterityModifier: Math.floor((monster.abilities.dex - 10) / 2),
    wisdomModifier: Math.floor((monster.abilities.wis - 10) / 2),
    constitutionModifier: Math.floor((monster.abilities.con - 10) / 2),
    hp: { ...monster.hp },
    ac: monster.ac,
    speed: monster.speed.walk || 30,
    position: undefined,
    conditions: monster.conditions ? [...monster.conditions] : [],
    concentratingOn: undefined,
    turnResources: {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementRemaining: monster.speed.walk || 30,
      freeObjectInteraction: true,
    },
    sourceId: monster.id,
    sourceType: 'monster',
    resistances: monster.resistances,
    immunities: monster.immunities,
    vulnerabilities: monster.vulnerabilities,
    experiencePoints: monster.experiencePoints ?? 0,
  };
}

/**
 * Reset turn resources for a combatant
 */
export function resetTurnResources(combatant: Combatant): Combatant {
  return {
    ...combatant,
    turnResources: {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementRemaining: combatant.speed,
      freeObjectInteraction: true,
    },
  };
}

/**
 * Check if a combatant is incapacitated
 */
export function isIncapacitated(combatant: Combatant): boolean {
  const incapacitatingConditions: ConditionName[] = [
    'Incapacitated',
    'Paralyzed',
    'Petrified',
    'Stunned',
    'Unconscious',
  ];
  
  return combatant.conditions.some(c => {
    const name = getConditionName(c);
    return incapacitatingConditions.includes(name);
  });
}

/**
 * Check if a combatant can take reactions
 */
export function canTakeReaction(combatant: Combatant): boolean {
  if (combatant.turnResources.reactionUsed) return false;
  if (isIncapacitated(combatant)) return false;
  
  // Check for conditions that prevent reactions
  const noReactionConditions: ConditionName[] = [
    'Incapacitated',
    'Unconscious',
    'Paralyzed',
    'Petrified',
    'Stunned',
  ];
  
  return !combatant.conditions.some(c => {
    const name = getConditionName(c);
    return noReactionConditions.includes(name);
  });
}

/**
 * Check if a combatant is dead or dying
 */
export function isDead(combatant: Combatant): boolean {
  if (combatant.hp.current <= 0) {
    // Monsters die at 0 HP
    if (combatant.type === 'monster') return true;
    
    // PCs die after 3 failed death saves
    if (combatant.deathSaves && combatant.deathSaves.failures >= 3) {
      return true;
    }
  }
  
  return false;
}

/**
 * Check if a combatant is stable (unconscious but not dying)
 */
export function isStable(combatant: Combatant): boolean {
  if (combatant.hp.current <= 0 && combatant.type === 'pc') {
    return combatant.deathSaves?.successes === 3;
  }
  return false;
}
