/**
 * Dice Rolling Utilities
 * Re-exports core dice functions and adds convenience helpers
 */

// Re-export core dice functionality from types
export {
  type DieType,
  type DiceRoll,
  type DiceRollResult,
  DIE_TYPES,
  DIE_MAX_VALUES,
  rollDie,
  rollDice,
  executeDiceRoll,
  parseDiceNotation,
  formatDiceRollResult,
  rollInitiative,
  rollAbilityCheck,
  rollSavingThrow,
  rollAttack,
  rollDamage,
  rollHitDice,
  rollPercentile,
  rollAbilityScore,
} from '../types/dice';

import { rollDie, rollDice } from '../types/dice';

/** Roll a d20 */
export const rollD20 = () => rollDie('d20');

/** Roll a d4 */
export const rollD4 = () => rollDie('d4');

/** Roll a d6 */
export const rollD6 = () => rollDie('d6');

/** Roll a d8 */
export const rollD8 = () => rollDie('d8');

/** Roll a d10 */
export const rollD10 = () => rollDie('d10');

/** Roll a d12 */
export const rollD12 = () => rollDie('d12');

/** Roll a d100 (percentile) */
export const rollD100 = () => rollDie('d100');

/** Roll multiple dice and return individual results */
export const rollDiceArray = (count: number, sides: number): number[] => 
  Array.from({ length: count }, () => Math.floor(Math.random() * sides) + 1);

/** Roll with advantage (2d20 take higher) */
export function rollWithAdvantage(): { result: number; rolls: [number, number] } {
  const rolls: [number, number] = [rollD20(), rollD20()];
  return { result: Math.max(...rolls), rolls };
}

/** Roll with disadvantage (2d20 take lower) */
export function rollWithDisadvantage(): { result: number; rolls: [number, number] } {
  const rolls: [number, number] = [rollD20(), rollD20()];
  return { result: Math.min(...rolls), rolls };
}

/** Parse a dice string like "2d6+3" */
export function parseDiceString(diceString: string): { count: number; sides: number; modifier: number } | null {
  const match = diceString.trim().match(/^(\d+)?d(\d+)([+-]\d+)?$/i);
  if (!match) return null;
  return {
    count: match[1] ? parseInt(match[1], 10) : 1,
    sides: parseInt(match[2], 10),
    modifier: match[3] ? parseInt(match[3], 10) : 0,
  };
}

/** Roll from a dice string expression */
export function rollFromString(diceString: string): { total: number; rolls: number[]; modifier: number } | null {
  const parsed = parseDiceString(diceString);
  if (!parsed) return null;
  
  const rolls = rollDiceArray(parsed.count, parsed.sides);
  return {
    total: rolls.reduce((a, b) => a + b, 0) + parsed.modifier,
    rolls,
    modifier: parsed.modifier,
  };
}

/** Roll 4d6 drop lowest for ability score generation */
export function roll4d6DropLowest(): { total: number; rolls: number[]; dropped: number } {
  const rolls = rollDiceArray(4, 6).sort((a, b) => b - a);
  const dropped = rolls.pop()!;
  return { total: rolls.reduce((a, b) => a + b, 0), rolls, dropped };
}

/** Generate a full set of ability scores */
export const generateAbilityScores = () => 
  Array.from({ length: 6 }, () => roll4d6DropLowest().total).sort((a, b) => b - a);

/** Roll damage with optional critical */
export function rollDamageFromExpression(
  expression: string,
  critical = false
): { total: number; rolls: number[]; expression: string } | null {
  const parsed = parseDiceString(expression);
  if (!parsed) return null;
  
  const diceCount = critical ? parsed.count * 2 : parsed.count;
  const rolls = rollDiceArray(diceCount, parsed.sides);
  
  return {
    total: Math.max(0, rolls.reduce((a, b) => a + b, 0) + parsed.modifier),
    rolls,
    expression: critical ? `${diceCount}d${parsed.sides}${parsed.modifier >= 0 ? '+' : ''}${parsed.modifier} (critical)` : expression,
  };
}

/** Roll on a weighted table */
export function rollOnTable<T>(table: Array<{ weight: number; value: T }>): T {
  const totalWeight = table.reduce((sum, e) => sum + e.weight, 0);
  let roll = Math.random() * totalWeight;
  
  for (const entry of table) {
    roll -= entry.weight;
    if (roll <= 0) return entry.value;
  }
  return table[table.length - 1].value;
}
