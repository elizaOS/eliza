/**
 * D&D 5e Dice System
 * Comprehensive dice rolling with all D&D mechanics
 */

export type DieType = 'd4' | 'd6' | 'd8' | 'd10' | 'd12' | 'd20' | 'd100';

export const DIE_TYPES: DieType[] = ['d4', 'd6', 'd8', 'd10', 'd12', 'd20', 'd100'];

export const DIE_MAX_VALUES: Record<DieType, number> = {
  'd4': 4,
  'd6': 6,
  'd8': 8,
  'd10': 10,
  'd12': 12,
  'd20': 20,
  'd100': 100,
};

export interface DiceRoll {
  count: number;
  die: DieType;
  modifier: number;
  advantage: boolean;
  disadvantage: boolean;
}

export interface DiceRollResult {
  roll: DiceRoll;
  individualRolls: number[];
  naturalRoll: number; // Sum of dice before modifier
  total: number;
  criticalHit: boolean; // Natural 20 on d20
  criticalFail: boolean; // Natural 1 on d20
  advantageRolls?: [number, number]; // Both rolls when advantage/disadvantage
  keptRoll?: number; // Which roll was kept
}

/**
 * Roll a single die
 */
export function rollDie(die: DieType): number {
  const max = DIE_MAX_VALUES[die];
  return Math.floor(Math.random() * max) + 1;
}

/**
 * Roll multiple dice
 */
export function rollDice(count: number, die: DieType): number[] {
  const results: number[] = [];
  for (let i = 0; i < count; i++) {
    results.push(rollDie(die));
  }
  return results;
}

/**
 * Execute a full dice roll with advantage/disadvantage
 */
export function executeDiceRoll(roll: DiceRoll): DiceRollResult {
  const isD20 = roll.die === 'd20' && roll.count === 1;
  
  // Handle advantage/disadvantage (only applies to single d20 rolls)
  if (isD20 && (roll.advantage || roll.disadvantage)) {
    const roll1 = rollDie('d20');
    const roll2 = rollDie('d20');
    
    let keptRoll: number;
    if (roll.advantage && !roll.disadvantage) {
      keptRoll = Math.max(roll1, roll2);
    } else if (roll.disadvantage && !roll.advantage) {
      keptRoll = Math.min(roll1, roll2);
    } else {
      // Both advantage and disadvantage cancel out
      keptRoll = roll1;
    }
    
    return {
      roll,
      individualRolls: [keptRoll],
      naturalRoll: keptRoll,
      total: keptRoll + roll.modifier,
      criticalHit: keptRoll === 20,
      criticalFail: keptRoll === 1,
      advantageRolls: [roll1, roll2],
      keptRoll,
    };
  }
  
  // Standard roll
  const individualRolls = rollDice(roll.count, roll.die);
  const naturalRoll = individualRolls.reduce((sum, r) => sum + r, 0);
  
  return {
    roll,
    individualRolls,
    naturalRoll,
    total: naturalRoll + roll.modifier,
    criticalHit: isD20 && individualRolls[0] === 20,
    criticalFail: isD20 && individualRolls[0] === 1,
  };
}

/**
 * Parse dice notation string (e.g., "2d6+3", "1d20", "4d8-2")
 */
export function parseDiceNotation(notation: string): DiceRoll {
  const regex = /^(\d+)?d(\d+)([+-]\d+)?$/i;
  const match = notation.trim().match(regex);
  
  if (!match) {
    throw new Error(`Invalid dice notation: ${notation}`);
  }
  
  const count = match[1] ? parseInt(match[1], 10) : 1;
  const dieValue = parseInt(match[2], 10);
  const modifier = match[3] ? parseInt(match[3], 10) : 0;
  
  const die = `d${dieValue}` as DieType;
  if (!DIE_TYPES.includes(die)) {
    throw new Error(`Invalid die type: d${dieValue}`);
  }
  
  return {
    count,
    die,
    modifier,
    advantage: false,
    disadvantage: false,
  };
}

/**
 * Format dice roll result for display
 */
export function formatDiceRollResult(result: DiceRollResult): string {
  const { roll, individualRolls, naturalRoll, total, criticalHit, criticalFail, advantageRolls } = result;
  
  let notation = `${roll.count}${roll.die}`;
  if (roll.modifier > 0) {
    notation += `+${roll.modifier}`;
  } else if (roll.modifier < 0) {
    notation += `${roll.modifier}`;
  }
  
  let rollStr = `[${individualRolls.join(', ')}]`;
  if (advantageRolls) {
    const advType = roll.advantage ? 'ADV' : 'DIS';
    rollStr = `[${advantageRolls[0]}, ${advantageRolls[1]}] (${advType}, kept ${result.keptRoll})`;
  }
  
  let resultStr = `${notation}: ${rollStr}`;
  if (roll.modifier !== 0) {
    const sign = roll.modifier > 0 ? '+' : '';
    resultStr += ` ${sign}${roll.modifier}`;
  }
  resultStr += ` = ${total}`;
  
  if (criticalHit) {
    resultStr += ' (CRITICAL HIT!)';
  } else if (criticalFail) {
    resultStr += ' (CRITICAL FAIL!)';
  }
  
  return resultStr;
}

/**
 * Roll for initiative (d20 + dex modifier)
 */
export function rollInitiative(dexterityModifier: number): DiceRollResult {
  return executeDiceRoll({
    count: 1,
    die: 'd20',
    modifier: dexterityModifier,
    advantage: false,
    disadvantage: false,
  });
}

/**
 * Roll ability check
 */
export function rollAbilityCheck(
  modifier: number,
  advantage: boolean = false,
  disadvantage: boolean = false
): DiceRollResult {
  return executeDiceRoll({
    count: 1,
    die: 'd20',
    modifier,
    advantage,
    disadvantage,
  });
}

/**
 * Roll saving throw
 */
export function rollSavingThrow(
  modifier: number,
  advantage: boolean = false,
  disadvantage: boolean = false
): DiceRollResult {
  return executeDiceRoll({
    count: 1,
    die: 'd20',
    modifier,
    advantage,
    disadvantage,
  });
}

/**
 * Roll attack
 */
export function rollAttack(
  attackBonus: number,
  advantage: boolean = false,
  disadvantage: boolean = false
): DiceRollResult {
  return executeDiceRoll({
    count: 1,
    die: 'd20',
    modifier: attackBonus,
    advantage,
    disadvantage,
  });
}

/**
 * Roll damage
 */
export function rollDamage(
  count: number,
  die: DieType,
  modifier: number,
  critical: boolean = false
): DiceRollResult {
  // On critical hit, double the dice (not the modifier)
  const diceCount = critical ? count * 2 : count;
  
  return executeDiceRoll({
    count: diceCount,
    die,
    modifier,
    advantage: false,
    disadvantage: false,
  });
}

/**
 * Roll hit dice for healing during rest
 */
export function rollHitDice(die: DieType, constitutionModifier: number): DiceRollResult {
  const result = executeDiceRoll({
    count: 1,
    die,
    modifier: constitutionModifier,
    advantage: false,
    disadvantage: false,
  });
  
  // Minimum healing of 1
  if (result.total < 1) {
    return {
      ...result,
      total: 1,
    };
  }
  
  return result;
}

/**
 * Roll percentile (d100)
 */
export function rollPercentile(): number {
  return rollDie('d100');
}

/**
 * Roll for ability scores using 4d6 drop lowest
 */
export function rollAbilityScore(): { total: number; rolls: number[]; dropped: number } {
  const rolls = rollDice(4, 'd6');
  const sorted = [...rolls].sort((a, b) => b - a);
  const dropped = sorted.pop()!;
  const total = sorted.reduce((sum, r) => sum + r, 0);
  
  return { total, rolls, dropped };
}
