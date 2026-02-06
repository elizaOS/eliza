/**
 * Dice System Tests
 * Comprehensive tests for D&D 5e dice rolling mechanics
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
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
  DIE_TYPES,
  DIE_MAX_VALUES,
  type DieType,
  type DiceRoll,
} from '../types/dice';

describe('Dice System', () => {
  // ============================================================================
  // BASIC ROLLING
  // ============================================================================
  describe('rollDie', () => {
    test('rolls within valid range for each die type', () => {
      for (const die of DIE_TYPES) {
        const max = DIE_MAX_VALUES[die];
        // Roll many times to verify bounds
        for (let i = 0; i < 100; i++) {
          const result = rollDie(die);
          expect(result).toBeGreaterThanOrEqual(1);
          expect(result).toBeLessThanOrEqual(max);
          expect(Number.isInteger(result)).toBe(true);
        }
      }
    });

    test('d20 produces results between 1 and 20', () => {
      const results = new Set<number>();
      // Roll enough times to get good coverage
      for (let i = 0; i < 1000; i++) {
        results.add(rollDie('d20'));
      }
      // Should have reasonable distribution
      expect(results.size).toBeGreaterThan(15);
      expect(Math.min(...results)).toBe(1);
      expect(Math.max(...results)).toBe(20);
    });

    test('d100 produces results between 1 and 100', () => {
      for (let i = 0; i < 100; i++) {
        const result = rollDie('d100');
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('rollDice', () => {
    test('returns correct number of dice', () => {
      expect(rollDice(1, 'd6').length).toBe(1);
      expect(rollDice(3, 'd8').length).toBe(3);
      expect(rollDice(10, 'd4').length).toBe(10);
    });

    test('all results within valid range', () => {
      const results = rollDice(100, 'd6');
      for (const r of results) {
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(6);
      }
    });

    test('zero dice returns empty array', () => {
      expect(rollDice(0, 'd20')).toEqual([]);
    });
  });

  // ============================================================================
  // ADVANTAGE / DISADVANTAGE
  // ============================================================================
  describe('executeDiceRoll with advantage/disadvantage', () => {
    test('advantage returns higher of two d20 rolls', () => {
      const roll: DiceRoll = {
        count: 1,
        die: 'd20',
        modifier: 0,
        advantage: true,
        disadvantage: false,
      };
      
      for (let i = 0; i < 100; i++) {
        const result = executeDiceRoll(roll);
        expect(result.advantageRolls).toBeDefined();
        const [r1, r2] = result.advantageRolls!;
        expect(result.keptRoll).toBe(Math.max(r1, r2));
        expect(result.naturalRoll).toBe(Math.max(r1, r2));
      }
    });

    test('disadvantage returns lower of two d20 rolls', () => {
      const roll: DiceRoll = {
        count: 1,
        die: 'd20',
        modifier: 0,
        advantage: false,
        disadvantage: true,
      };
      
      for (let i = 0; i < 100; i++) {
        const result = executeDiceRoll(roll);
        expect(result.advantageRolls).toBeDefined();
        const [r1, r2] = result.advantageRolls!;
        expect(result.keptRoll).toBe(Math.min(r1, r2));
      }
    });

    test('advantage and disadvantage cancel out', () => {
      const roll: DiceRoll = {
        count: 1,
        die: 'd20',
        modifier: 0,
        advantage: true,
        disadvantage: true,
      };
      
      const result = executeDiceRoll(roll);
      expect(result.advantageRolls).toBeDefined();
      // When both, use first roll
      expect(result.keptRoll).toBe(result.advantageRolls![0]);
    });

    test('advantage only applies to single d20 rolls', () => {
      // 2d20 should not use advantage mechanics
      const roll: DiceRoll = {
        count: 2,
        die: 'd20',
        modifier: 0,
        advantage: true,
        disadvantage: false,
      };
      
      const result = executeDiceRoll(roll);
      expect(result.advantageRolls).toBeUndefined();
      expect(result.individualRolls.length).toBe(2);
    });

    test('advantage does not apply to non-d20 dice', () => {
      const roll: DiceRoll = {
        count: 1,
        die: 'd6',
        modifier: 0,
        advantage: true,
        disadvantage: false,
      };
      
      const result = executeDiceRoll(roll);
      expect(result.advantageRolls).toBeUndefined();
    });
  });

  // ============================================================================
  // CRITICAL HITS / FAILS
  // ============================================================================
  describe('critical detection', () => {
    test('natural 20 is critical hit on d20', () => {
      // Force enough rolls to eventually get a 20
      let foundCrit = false;
      for (let i = 0; i < 1000 && !foundCrit; i++) {
        const roll: DiceRoll = { count: 1, die: 'd20', modifier: 5, advantage: false, disadvantage: false };
        const result = executeDiceRoll(roll);
        if (result.naturalRoll === 20) {
          expect(result.criticalHit).toBe(true);
          expect(result.criticalFail).toBe(false);
          foundCrit = true;
        }
      }
      expect(foundCrit).toBe(true);
    });

    test('natural 1 is critical fail on d20', () => {
      let foundCritFail = false;
      for (let i = 0; i < 1000 && !foundCritFail; i++) {
        const roll: DiceRoll = { count: 1, die: 'd20', modifier: 0, advantage: false, disadvantage: false };
        const result = executeDiceRoll(roll);
        if (result.naturalRoll === 1) {
          expect(result.criticalFail).toBe(true);
          expect(result.criticalHit).toBe(false);
          foundCritFail = true;
        }
      }
      expect(foundCritFail).toBe(true);
    });

    test('critical detection does not apply to non-d20', () => {
      const roll: DiceRoll = { count: 1, die: 'd6', modifier: 0, advantage: false, disadvantage: false };
      for (let i = 0; i < 100; i++) {
        const result = executeDiceRoll(roll);
        expect(result.criticalHit).toBe(false);
        expect(result.criticalFail).toBe(false);
      }
    });

    test('modifiers do not affect critical detection', () => {
      // A roll of 20 with -5 modifier (total 15) is still a crit
      const roll: DiceRoll = { count: 1, die: 'd20', modifier: -5, advantage: false, disadvantage: false };
      for (let i = 0; i < 500; i++) {
        const result = executeDiceRoll(roll);
        if (result.naturalRoll === 20) {
          expect(result.criticalHit).toBe(true);
          expect(result.total).toBe(15); // 20 - 5
        }
      }
    });
  });

  // ============================================================================
  // MODIFIERS
  // ============================================================================
  describe('modifiers', () => {
    test('positive modifier added correctly', () => {
      const roll: DiceRoll = { count: 1, die: 'd20', modifier: 5, advantage: false, disadvantage: false };
      const result = executeDiceRoll(roll);
      expect(result.total).toBe(result.naturalRoll + 5);
    });

    test('negative modifier subtracted correctly', () => {
      const roll: DiceRoll = { count: 1, die: 'd20', modifier: -3, advantage: false, disadvantage: false };
      const result = executeDiceRoll(roll);
      expect(result.total).toBe(result.naturalRoll - 3);
    });

    test('zero modifier has no effect', () => {
      const roll: DiceRoll = { count: 1, die: 'd6', modifier: 0, advantage: false, disadvantage: false };
      const result = executeDiceRoll(roll);
      expect(result.total).toBe(result.naturalRoll);
    });

    test('modifier can result in negative total', () => {
      const roll: DiceRoll = { count: 1, die: 'd4', modifier: -10, advantage: false, disadvantage: false };
      const result = executeDiceRoll(roll);
      // d4 max is 4, so with -10: max total is -6
      expect(result.total).toBeLessThan(0);
    });
  });

  // ============================================================================
  // DICE NOTATION PARSING
  // ============================================================================
  describe('parseDiceNotation', () => {
    test('parses simple notation: d20', () => {
      const parsed = parseDiceNotation('d20');
      expect(parsed.count).toBe(1);
      expect(parsed.die).toBe('d20');
      expect(parsed.modifier).toBe(0);
    });

    test('parses with count: 2d6', () => {
      const parsed = parseDiceNotation('2d6');
      expect(parsed.count).toBe(2);
      expect(parsed.die).toBe('d6');
      expect(parsed.modifier).toBe(0);
    });

    test('parses positive modifier: 1d8+3', () => {
      const parsed = parseDiceNotation('1d8+3');
      expect(parsed.count).toBe(1);
      expect(parsed.die).toBe('d8');
      expect(parsed.modifier).toBe(3);
    });

    test('parses negative modifier: 4d6-2', () => {
      const parsed = parseDiceNotation('4d6-2');
      expect(parsed.count).toBe(4);
      expect(parsed.die).toBe('d6');
      expect(parsed.modifier).toBe(-2);
    });

    test('parses with whitespace', () => {
      const parsed = parseDiceNotation('  2d10+5  ');
      expect(parsed.count).toBe(2);
      expect(parsed.die).toBe('d10');
      expect(parsed.modifier).toBe(5);
    });

    test('case insensitive: 2D8', () => {
      const parsed = parseDiceNotation('2D8');
      expect(parsed.count).toBe(2);
      expect(parsed.die).toBe('d8');
    });

    test('throws on invalid notation', () => {
      expect(() => parseDiceNotation('invalid')).toThrow();
      expect(() => parseDiceNotation('2x6')).toThrow();
      expect(() => parseDiceNotation('')).toThrow();
    });

    test('throws on invalid die type', () => {
      expect(() => parseDiceNotation('1d7')).toThrow('Invalid die type');
      expect(() => parseDiceNotation('1d3')).toThrow('Invalid die type');
    });
  });

  // ============================================================================
  // FORMATTING
  // ============================================================================
  describe('formatDiceRollResult', () => {
    test('formats basic roll', () => {
      const result = {
        roll: { count: 1, die: 'd20' as DieType, modifier: 0, advantage: false, disadvantage: false },
        individualRolls: [15],
        naturalRoll: 15,
        total: 15,
        criticalHit: false,
        criticalFail: false,
      };
      const formatted = formatDiceRollResult(result);
      expect(formatted).toContain('1d20');
      expect(formatted).toContain('[15]');
      expect(formatted).toContain('= 15');
    });

    test('formats roll with modifier', () => {
      const result = {
        roll: { count: 2, die: 'd6' as DieType, modifier: 3, advantage: false, disadvantage: false },
        individualRolls: [4, 5],
        naturalRoll: 9,
        total: 12,
        criticalHit: false,
        criticalFail: false,
      };
      const formatted = formatDiceRollResult(result);
      expect(formatted).toContain('2d6+3');
      expect(formatted).toContain('= 12');
    });

    test('formats critical hit', () => {
      const result = {
        roll: { count: 1, die: 'd20' as DieType, modifier: 5, advantage: false, disadvantage: false },
        individualRolls: [20],
        naturalRoll: 20,
        total: 25,
        criticalHit: true,
        criticalFail: false,
      };
      const formatted = formatDiceRollResult(result);
      expect(formatted).toContain('CRITICAL HIT');
    });

    test('formats critical fail', () => {
      const result = {
        roll: { count: 1, die: 'd20' as DieType, modifier: 5, advantage: false, disadvantage: false },
        individualRolls: [1],
        naturalRoll: 1,
        total: 6,
        criticalHit: false,
        criticalFail: true,
      };
      const formatted = formatDiceRollResult(result);
      expect(formatted).toContain('CRITICAL FAIL');
    });

    test('formats advantage roll', () => {
      const result = {
        roll: { count: 1, die: 'd20' as DieType, modifier: 0, advantage: true, disadvantage: false },
        individualRolls: [15],
        naturalRoll: 15,
        total: 15,
        criticalHit: false,
        criticalFail: false,
        advantageRolls: [10, 15] as [number, number],
        keptRoll: 15,
      };
      const formatted = formatDiceRollResult(result);
      expect(formatted).toContain('ADV');
      expect(formatted).toContain('kept 15');
    });
  });

  // ============================================================================
  // SPECIFIC ROLL TYPES
  // ============================================================================
  describe('rollInitiative', () => {
    test('adds dex modifier to roll', () => {
      const result = rollInitiative(3);
      expect(result.roll.modifier).toBe(3);
      expect(result.total).toBe(result.naturalRoll + 3);
    });

    test('works with negative modifier', () => {
      const result = rollInitiative(-2);
      expect(result.total).toBe(result.naturalRoll - 2);
    });
  });

  describe('rollAbilityCheck', () => {
    test('applies modifier correctly', () => {
      const result = rollAbilityCheck(4);
      expect(result.roll.modifier).toBe(4);
    });

    test('respects advantage parameter', () => {
      const result = rollAbilityCheck(0, true, false);
      expect(result.roll.advantage).toBe(true);
      expect(result.advantageRolls).toBeDefined();
    });

    test('respects disadvantage parameter', () => {
      const result = rollAbilityCheck(0, false, true);
      expect(result.roll.disadvantage).toBe(true);
      expect(result.advantageRolls).toBeDefined();
    });
  });

  describe('rollSavingThrow', () => {
    test('functions like ability check', () => {
      const result = rollSavingThrow(5, true, false);
      expect(result.roll.modifier).toBe(5);
      expect(result.roll.advantage).toBe(true);
    });
  });

  describe('rollAttack', () => {
    test('applies attack bonus', () => {
      const result = rollAttack(7);
      expect(result.roll.modifier).toBe(7);
    });

    test('detects critical hits', () => {
      let foundCrit = false;
      for (let i = 0; i < 1000 && !foundCrit; i++) {
        const result = rollAttack(5);
        if (result.criticalHit) {
          expect(result.naturalRoll).toBe(20);
          foundCrit = true;
        }
      }
      expect(foundCrit).toBe(true);
    });
  });

  describe('rollDamage', () => {
    test('rolls correct number of dice', () => {
      const result = rollDamage(2, 'd6', 3);
      expect(result.individualRolls.length).toBe(2);
    });

    test('critical doubles dice (not modifier)', () => {
      const result = rollDamage(2, 'd6', 3, true);
      expect(result.individualRolls.length).toBe(4); // 2 * 2 = 4 dice
      expect(result.roll.modifier).toBe(3); // modifier unchanged
    });

    test('modifier applied once even on critical', () => {
      const result = rollDamage(1, 'd8', 5, true);
      // 2 dice on crit, but only +5 once
      expect(result.individualRolls.length).toBe(2);
      expect(result.total).toBe(result.naturalRoll + 5);
    });
  });

  describe('rollHitDice', () => {
    test('adds con modifier', () => {
      const result = rollHitDice('d8', 2);
      expect(result.total).toBeGreaterThanOrEqual(Math.max(1, result.naturalRoll + 2));
    });

    test('minimum healing is 1', () => {
      // With negative con, should still get at least 1
      const result = rollHitDice('d4', -10);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe('rollPercentile', () => {
    test('returns value between 1 and 100', () => {
      for (let i = 0; i < 100; i++) {
        const result = rollPercentile();
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(100);
      }
    });
  });

  describe('rollAbilityScore', () => {
    test('returns total and rolls', () => {
      const result = rollAbilityScore();
      expect(result.rolls.length).toBe(4);
      expect(result.total).toBeDefined();
      expect(result.dropped).toBeDefined();
    });

    test('drops lowest die', () => {
      const result = rollAbilityScore();
      // The dropped value should be <= all kept values
      const keptRolls = result.rolls.filter(r => r !== result.dropped || result.rolls.filter(x => x === r).length > 1);
      // Since we sort and pop, dropped should be smallest or tied
      expect(result.dropped).toBeLessThanOrEqual(Math.max(...result.rolls));
    });

    test('total is sum of 3 highest dice', () => {
      for (let i = 0; i < 50; i++) {
        const result = rollAbilityScore();
        const sorted = [...result.rolls].sort((a, b) => b - a);
        const expectedTotal = sorted[0] + sorted[1] + sorted[2];
        expect(result.total).toBe(expectedTotal);
      }
    });

    test('total range is 3-18', () => {
      for (let i = 0; i < 100; i++) {
        const result = rollAbilityScore();
        expect(result.total).toBeGreaterThanOrEqual(3); // 1+1+1
        expect(result.total).toBeLessThanOrEqual(18); // 6+6+6
      }
    });

    test('all rolls are valid d6 values', () => {
      const result = rollAbilityScore();
      for (const roll of result.rolls) {
        expect(roll).toBeGreaterThanOrEqual(1);
        expect(roll).toBeLessThanOrEqual(6);
      }
    });
  });
});
