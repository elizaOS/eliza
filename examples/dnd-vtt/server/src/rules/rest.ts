/**
 * Rest Rules
 * D&D 5e short rest and long rest mechanics
 */

import {
  type CharacterSheet,
  type ActiveCondition,
  executeDiceRoll,
  getHP,
  getAbilityMod,
} from '../types';

export interface ShortRestParams {
  character: CharacterSheet;
  hitDiceToSpend: number;
}

export interface ShortRestResult {
  hpRestored: number;
  hitDiceUsed: number;
  hitDiceRolls: number[];
  newCurrentHP: number;
  newHitDiceRemaining: number;
  description: string;
}

export interface LongRestParams {
  character: CharacterSheet;
  wasInterrupted?: boolean;
  interruptionDuration?: number; // in hours
}

export interface LongRestResult {
  hpRestored: number;
  hitDiceRecovered: number;
  spellSlotsRestored: boolean;
  conditionsRemoved: string[];
  newCurrentHP: number;
  newHitDiceRemaining: number;
  wasSuccessful: boolean;
  description: string;
}

/**
 * Get hit die type for a class
 */
export function getHitDieType(className: string): 'd6' | 'd8' | 'd10' | 'd12' {
  const hitDice: Record<string, 'd6' | 'd8' | 'd10' | 'd12'> = {
    barbarian: 'd12',
    fighter: 'd10',
    paladin: 'd10',
    ranger: 'd10',
    bard: 'd8',
    cleric: 'd8',
    druid: 'd8',
    monk: 'd8',
    rogue: 'd8',
    warlock: 'd8',
    sorcerer: 'd6',
    wizard: 'd6',
    artificer: 'd8',
  };
  
  return hitDice[className.toLowerCase()] || 'd8';
}

/**
 * Perform a short rest
 */
export function takeShortRest(params: ShortRestParams): ShortRestResult {
  const { character, hitDiceToSpend } = params;
  
  // Determine how many hit dice the character has
  const maxHitDice = character.level;
  const currentHitDice = character.hitDice?.current ?? maxHitDice;
  const hitDieType = getHitDieType(character.class);
  
  // Can't spend more hit dice than available
  const diceToRoll = Math.min(hitDiceToSpend, currentHitDice);
  
  if (diceToRoll <= 0) {
    return {
      hpRestored: 0,
      hitDiceUsed: 0,
      hitDiceRolls: [],
      newCurrentHP: getHP(character).current,
      newHitDiceRemaining: currentHitDice,
      description: `${character.name} has no hit dice remaining to spend.`,
    };
  }
  
  const conMod = getAbilityMod(character.abilities.constitution);
  const hitDiceRolls: number[] = [];
  let totalHealing = 0;
  
  // Roll hit dice
  for (let i = 0; i < diceToRoll; i++) {
    const roll = executeDiceRoll({
      count: 1,
      die: hitDieType,
      modifier: 0,
      advantage: false,
      disadvantage: false,
    });
    
    const healAmount = roll.total + conMod;
    // Minimum 0 healing per die (can't lose HP from resting)
    const actualHeal = Math.max(0, healAmount);
    hitDiceRolls.push(roll.total);
    totalHealing += actualHeal;
  }
  
  // Calculate new HP (can't exceed max)
  const hp = getHP(character);
  const newHP = Math.min(
    hp.max,
    hp.current + totalHealing
  );
  
  const newHitDiceRemaining = currentHitDice - diceToRoll;
  
  return {
    hpRestored: newHP - hp.current,
    hitDiceUsed: diceToRoll,
    hitDiceRolls,
    newCurrentHP: newHP,
    newHitDiceRemaining,
    description: `${character.name} takes a short rest, spending ${diceToRoll} hit ${diceToRoll === 1 ? 'die' : 'dice'} (${hitDiceRolls.join(', ')}) and restoring ${newHP - hp.current} HP.`,
  };
}

/**
 * Perform a long rest
 */
export function takeLongRest(params: LongRestParams): LongRestResult {
  const { character, wasInterrupted = false, interruptionDuration = 0 } = params;
  
  // Long rest requires at least 6 hours of sleep and 2 hours of light activity
  // If interrupted for more than 1 hour, must restart
  const charHP = getHP(character);
  
  if (wasInterrupted && interruptionDuration > 1) {
    return {
      hpRestored: 0,
      hitDiceRecovered: 0,
      spellSlotsRestored: false,
      conditionsRemoved: [],
      newCurrentHP: charHP.current,
      newHitDiceRemaining: character.hitDice?.current ?? character.level,
      wasSuccessful: false,
      description: `${character.name}'s long rest was interrupted for too long (${interruptionDuration} hours). The rest must be restarted.`,
    };
  }
  
  // Restore all HP
  const hpRestored = charHP.max - charHP.current;
  
  // Recover half of max hit dice (minimum 1)
  const maxHitDice = character.level;
  const currentHitDice = character.hitDice?.current ?? maxHitDice;
  const hitDiceToRecover = Math.max(1, Math.floor(maxHitDice / 2));
  const newHitDiceRemaining = Math.min(maxHitDice, currentHitDice + hitDiceToRecover);
  const actualHitDiceRecovered = newHitDiceRemaining - currentHitDice;
  
  // Remove certain conditions (exhaustion decreases by 1 if food/water obtained)
  const conditionsRemoved: string[] = [];
  
  // Build description
  let description = `${character.name} completes a long rest.`;
  
  if (hpRestored > 0) {
    description += ` Restored ${hpRestored} HP (now at max).`;
  }
  
  if (actualHitDiceRecovered > 0) {
    description += ` Recovered ${actualHitDiceRecovered} hit ${actualHitDiceRecovered === 1 ? 'die' : 'dice'}.`;
  }
  
  description += ` All spell slots restored.`;
  
  return {
    hpRestored,
    hitDiceRecovered: actualHitDiceRecovered,
    spellSlotsRestored: true,
    conditionsRemoved,
    newCurrentHP: charHP.max,
    newHitDiceRemaining,
    wasSuccessful: true,
    description,
  };
}

/**
 * Calculate how many hit dice a character should have at a given point
 */
export function calculateHitDiceRemaining(
  level: number,
  hitDiceSpent: number,
  longRestsCompleted: number
): number {
  const maxHitDice = level;
  
  // Each long rest recovers half max (min 1)
  const recoveredPerRest = Math.max(1, Math.floor(maxHitDice / 2));
  const totalRecovered = recoveredPerRest * longRestsCompleted;
  
  // Can't exceed max
  return Math.min(maxHitDice, Math.max(0, maxHitDice - hitDiceSpent + totalRecovered));
}

/**
 * Restore spell slots for a class
 */
export function restoreSpellSlots(character: CharacterSheet): CharacterSheet['spellSlots'] {
  // Full casters, half casters, etc. have different progressions
  // For simplicity, return the max spell slots for the character's class/level
  
  const spellSlots = character.spellSlots;
  if (!spellSlots) return undefined;
  
  // Copy slots but reset current to max
  const restored: CharacterSheet['spellSlots'] = {};
  
  for (const [level, slot] of Object.entries(spellSlots)) {
    if (slot) {
      restored[parseInt(level) as keyof typeof restored] = {
        max: slot.max,
        current: slot.max,
      };
    }
  }
  
  return restored;
}

/**
 * Determine if character can benefit from long rest
 * (Can only benefit once per 24 hours)
 */
export function canTakeLongRest(lastLongRestTime: Date, currentTime: Date): boolean {
  const hoursSinceLastRest = (currentTime.getTime() - lastLongRestTime.getTime()) / (1000 * 60 * 60);
  return hoursSinceLastRest >= 24;
}

/**
 * Warlock short rest: restore Pact Magic slots
 */
export function restoreWarlockSlots(character: CharacterSheet): CharacterSheet['spellSlots'] {
  if (character.class.toLowerCase() !== 'warlock') {
    return character.spellSlots;
  }
  
  // Warlocks have special pact magic that restores on short rest
  // They get 1-4 slots depending on level, all same level
  const spellSlots = character.spellSlots;
  if (!spellSlots) return undefined;
  
  // Restore all warlock pact slots to max
  const restored = { ...spellSlots };
  
  // Warlocks typically only have one slot level (their pact slot level)
  // This is a simplification - full implementation would track pact magic separately
  for (const level of Object.keys(restored)) {
    const slotLevel = parseInt(level);
    if (restored[slotLevel as keyof typeof restored]) {
      restored[slotLevel as keyof typeof restored] = {
        max: restored[slotLevel as keyof typeof restored]!.max,
        current: restored[slotLevel as keyof typeof restored]!.max,
      };
    }
  }
  
  return restored;
}
