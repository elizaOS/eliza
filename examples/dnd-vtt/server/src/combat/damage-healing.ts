/**
 * Damage and Healing Resolution
 * Handles damage application, resistance, and healing
 */

import type { Combatant, CombatLogEntry, DiceRollResult } from './combat-state';
import type { DamageType, ConditionName } from '../types';
import { parseDiceString } from '../dice';

// Helper to roll a die with arbitrary sides
function rollDieOfSides(sides: number): number {
  return Math.floor(Math.random() * sides) + 1;
}

export interface DamageInstance {
  amount: number;
  type: DamageType;
  source: string;
  isCritical: boolean;
  isMagical?: boolean;
}

export interface DamageResult {
  originalAmount: number;
  finalAmount: number;
  damageType: DamageType;
  wasResisted: boolean;
  wasImmune: boolean;
  wasVulnerable: boolean;
  newHp: number;
  isDown: boolean;
  instantKill: boolean;
  description: string;
}

export interface HealingResult {
  amount: number;
  newHp: number;
  overhealing: number;
  wasUnconscious: boolean;
  description: string;
}

/**
 * Apply damage to a combatant
 */
export function applyDamage(
  combatant: Combatant,
  damage: DamageInstance
): { combatant: Combatant; result: DamageResult } {
  // Floor damage at 0 - negative damage should not heal
  let finalAmount = Math.max(0, damage.amount);
  let wasResisted = false;
  let wasImmune = false;
  let wasVulnerable = false;
  
  // Check immunity
  if (combatant.immunities?.includes(damage.type)) {
    finalAmount = 0;
    wasImmune = true;
  }
  // Check resistance
  else if (combatant.resistances?.includes(damage.type)) {
    finalAmount = Math.floor(damage.amount / 2);
    wasResisted = true;
  }
  // Check vulnerability
  else if (combatant.vulnerabilities?.includes(damage.type)) {
    finalAmount = damage.amount * 2;
    wasVulnerable = true;
  }
  
  // Apply temporary HP first
  let remainingDamage = finalAmount;
  let newTemp = combatant.hp.temp;
  
  if (newTemp > 0) {
    if (newTemp >= remainingDamage) {
      newTemp -= remainingDamage;
      remainingDamage = 0;
    } else {
      remainingDamage -= newTemp;
      newTemp = 0;
    }
  }
  
  // Apply remaining damage to HP
  const newCurrent = Math.max(0, combatant.hp.current - remainingDamage);
  const isDown = newCurrent === 0 && combatant.hp.current > 0;
  
  // Check for instant kill (massive damage)
  const instantKill = combatant.type === 'pc' && 
    remainingDamage >= combatant.hp.current + combatant.hp.max;
  
  // Build description
  let description = `${combatant.name} takes ${finalAmount} ${damage.type} damage`;
  
  if (wasImmune) {
    description = `${combatant.name} is immune to ${damage.type} damage!`;
  } else if (wasResisted) {
    description += ` (resisted from ${damage.amount})`;
  } else if (wasVulnerable) {
    description += ` (vulnerable - doubled from ${damage.amount})`;
  }
  
  if (damage.isCritical) {
    description += ' [CRITICAL]';
  }
  
  if (instantKill) {
    description += ` - **INSTANT DEATH** from massive damage!`;
  } else if (isDown) {
    description += ` - ${combatant.name} falls unconscious!`;
  }
  
  const updatedCombatant: Combatant = {
    ...combatant,
    hp: {
      ...combatant.hp,
      current: newCurrent,
      temp: newTemp,
    },
    // Reset death saves if going down
    deathSaves: isDown && combatant.type === 'pc'
      ? { successes: 0, failures: 0 }
      : combatant.deathSaves,
  };
  
  // Add unconscious condition if down
  if (isDown && !instantKill) {
    const hasUnconscious = updatedCombatant.conditions.some(c => c.condition === 'unconscious');
    if (!hasUnconscious) {
      updatedCombatant.conditions = [
        ...updatedCombatant.conditions,
        { condition: 'unconscious', sourceId: 'damage' },
      ];
    }
  }
  
  return {
    combatant: updatedCombatant,
    result: {
      originalAmount: damage.amount,
      finalAmount,
      damageType: damage.type,
      wasResisted,
      wasImmune,
      wasVulnerable,
      newHp: newCurrent,
      isDown,
      instantKill,
      description,
    },
  };
}

/**
 * Apply multiple damage instances to a combatant
 */
export function applyMultipleDamage(
  combatant: Combatant,
  damages: DamageInstance[]
): { combatant: Combatant; results: DamageResult[] } {
  let currentCombatant = combatant;
  const results: DamageResult[] = [];
  
  for (const damage of damages) {
    const { combatant: updated, result } = applyDamage(currentCombatant, damage);
    currentCombatant = updated;
    results.push(result);
    
    // Stop if instant killed
    if (result.instantKill) break;
  }
  
  return { combatant: currentCombatant, results };
}

/**
 * Apply healing to a combatant
 */
export function applyHealing(
  combatant: Combatant,
  amount: number,
  source: string
): { combatant: Combatant; result: HealingResult } {
  const wasUnconscious = combatant.hp.current === 0;
  const actualHealing = Math.min(amount, combatant.hp.max - combatant.hp.current);
  const overhealing = amount - actualHealing;
  const newHp = combatant.hp.current + actualHealing;
  
  let description = `${combatant.name} is healed for ${actualHealing} HP (${newHp}/${combatant.hp.max})`;
  
  if (wasUnconscious && newHp > 0) {
    description += ` - ${combatant.name} regains consciousness!`;
  }
  
  if (overhealing > 0) {
    description += ` (${overhealing} overhealing)`;
  }
  
  // Remove unconscious condition if healed above 0
  let updatedConditions = combatant.conditions;
  if (wasUnconscious && newHp > 0) {
    updatedConditions = updatedConditions.filter(c => c.condition !== 'unconscious');
  }
  
  const updatedCombatant: Combatant = {
    ...combatant,
    hp: {
      ...combatant.hp,
      current: newHp,
    },
    conditions: updatedConditions,
    // Reset death saves on healing
    deathSaves: wasUnconscious && newHp > 0 
      ? { successes: 0, failures: 0 }
      : combatant.deathSaves,
  };
  
  return {
    combatant: updatedCombatant,
    result: {
      amount: actualHealing,
      newHp,
      overhealing,
      wasUnconscious,
      description,
    },
  };
}

/**
 * Apply temporary HP to a combatant
 */
export function applyTempHP(
  combatant: Combatant,
  amount: number
): Combatant {
  // Temp HP doesn't stack - take the higher value
  const newTemp = Math.max(combatant.hp.temp, amount);
  
  return {
    ...combatant,
    hp: {
      ...combatant.hp,
      temp: newTemp,
    },
  };
}

/**
 * Roll damage dice and return the result
 */
export function rollDamage(
  diceExpression: string,
  isCritical: boolean = false
): { total: number; rolls: number[]; expression: string } {
  const parsed = parseDiceString(diceExpression);
  
  if (!parsed) {
    return { total: 0, rolls: [], expression: diceExpression };
  }
  
  // On critical, double the dice (not the modifier)
  const numDice = isCritical ? parsed.count * 2 : parsed.count;
  const rolls: number[] = [];
  
  for (let i = 0; i < numDice; i++) {
    rolls.push(rollDieOfSides(parsed.sides));
  }
  
  const total = rolls.reduce((sum, r) => sum + r, 0) + parsed.modifier;
  const expression = isCritical 
    ? `${numDice}d${parsed.sides}${parsed.modifier >= 0 ? '+' : ''}${parsed.modifier} (critical)`
    : diceExpression;
  
  return { total: Math.max(0, total), rolls, expression };
}

/**
 * Calculate average damage for a dice expression
 */
export function averageDamage(diceExpression: string): number {
  const parsed = parseDiceString(diceExpression);
  
  if (!parsed) {
    return 0;
  }
  
  const avgRoll = (parsed.sides + 1) / 2;
  return Math.floor(parsed.count * avgRoll) + parsed.modifier;
}

/**
 * Check if damage would break concentration
 */
export function checkConcentration(
  combatant: Combatant,
  damageTaken: number
): { mustCheck: boolean; dc: number } {
  if (!combatant.concentratingOn) {
    return { mustCheck: false, dc: 0 };
  }
  
  // DC is 10 or half the damage taken, whichever is higher
  const dc = Math.max(10, Math.floor(damageTaken / 2));
  
  return { mustCheck: true, dc };
}

/**
 * Break a combatant's concentration
 */
export function breakConcentration(combatant: Combatant): Combatant {
  return {
    ...combatant,
    concentratingOn: undefined,
  };
}

/**
 * Damage dealt by death at 0 HP forces death save failures
 */
export function applyDamageWhileDying(
  combatant: Combatant,
  damage: DamageInstance
): Combatant {
  if (combatant.hp.current > 0 || !combatant.deathSaves) {
    return combatant;
  }
  
  // Damage at 0 HP causes a death save failure
  // Critical hits cause 2 failures
  const failures = damage.isCritical ? 2 : 1;
  
  return {
    ...combatant,
    deathSaves: {
      ...combatant.deathSaves,
      failures: Math.min(3, combatant.deathSaves.failures + failures),
    },
  };
}

/**
 * Get a narrative description of damage
 */
export function describeDamage(amount: number, type: DamageType, targetName: string): string {
  const intensity = amount >= 30 ? 'devastating'
    : amount >= 20 ? 'massive'
    : amount >= 15 ? 'significant'
    : amount >= 10 ? 'solid'
    : amount >= 5 ? 'moderate'
    : 'minor';
  
  const damageVerbs: Record<DamageType, string[]> = {
    bludgeoning: ['slams into', 'crashes against', 'pounds'],
    piercing: ['stabs into', 'pierces through', 'punctures'],
    slashing: ['slices into', 'cuts across', 'rends'],
    fire: ['burns', 'scorches', 'ignites'],
    cold: ['freezes', 'chills', 'frosts'],
    lightning: ['shocks', 'electrifies', 'jolts'],
    thunder: ['blasts', 'deafens', 'shakes'],
    acid: ['corrodes', 'dissolves', 'eats into'],
    poison: ['sickens', 'poisons', 'taints'],
    necrotic: ['withers', 'drains', 'decays'],
    radiant: ['sears', 'scorches with holy light', 'burns with radiance'],
    force: ['impacts', 'strikes with pure force', 'hammers'],
    psychic: ['assaults the mind of', 'mentally ravages', 'shatters the thoughts of'],
  };
  
  const verbs = damageVerbs[type] || ['damages'];
  const verb = verbs[Math.floor(Math.random() * verbs.length)];
  
  return `A ${intensity} blow ${verb} ${targetName}!`;
}
