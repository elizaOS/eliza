/**
 * Damage & Healing System Tests
 * Comprehensive tests for D&D 5e damage and healing mechanics
 */

import { describe, test, expect } from 'bun:test';
import {
  applyDamage,
  applyMultipleDamage,
  applyHealing,
  applyTempHP,
  rollDamage,
  averageDamage,
  checkConcentration,
  breakConcentration,
  applyDamageWhileDying,
  describeDamage,
  type DamageInstance,
} from '../combat/damage-healing';
import type { Combatant } from '../combat/combat-state';

// Helper to create a test combatant with all required fields
function createCombatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    id: 'test-1',
    name: 'Test Fighter',
    type: 'pc',
    initiative: 15,
    dexterityModifier: 2,
    wisdomModifier: 0,
    constitutionModifier: 0,
    hp: { current: 30, max: 50, temp: 0 },
    ac: 16,
    speed: 30,
    conditions: [],
    deathSaves: { successes: 0, failures: 0 },
    turnResources: {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementRemaining: 30,
      freeObjectInteraction: true,
    },
    sourceId: 'char-1',
    sourceType: 'character',
    ...overrides,
  };
}

describe('Damage & Healing System', () => {
  // ============================================================================
  // BASIC DAMAGE
  // ============================================================================
  describe('applyDamage', () => {
    test('reduces HP by damage amount', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 0 } });
      const damage: DamageInstance = {
        amount: 10,
        type: 'slashing',
        source: 'sword',
        isCritical: false,
      };
      
      const { combatant: updated, result } = applyDamage(combatant, damage);
      
      expect(updated.hp.current).toBe(20);
      expect(result.finalAmount).toBe(10);
      expect(result.newHp).toBe(20);
      expect(result.isDown).toBe(false);
    });

    test('cannot reduce HP below 0', () => {
      const combatant = createCombatant({ hp: { current: 5, max: 50, temp: 0 } });
      const damage: DamageInstance = {
        amount: 20,
        type: 'bludgeoning',
        source: 'club',
        isCritical: false,
      };
      
      const { combatant: updated, result } = applyDamage(combatant, damage);
      
      expect(updated.hp.current).toBe(0);
      expect(result.newHp).toBe(0);
      expect(result.isDown).toBe(true);
    });

    test('applies unconscious condition when dropping to 0 HP', () => {
      const combatant = createCombatant({ hp: { current: 5, max: 50, temp: 0 } });
      const damage: DamageInstance = {
        amount: 10,
        type: 'piercing',
        source: 'arrow',
        isCritical: false,
      };
      
      const { combatant: updated, result } = applyDamage(combatant, damage);
      
      expect(result.isDown).toBe(true);
      expect(updated.conditions.some(c => c.condition === 'unconscious')).toBe(true);
    });

    test('resets death saves when going down', () => {
      const combatant = createCombatant({
        hp: { current: 5, max: 50, temp: 0 },
        deathSaves: { successes: 2, failures: 1 },
      });
      const damage: DamageInstance = {
        amount: 10,
        type: 'fire',
        source: 'fireball',
        isCritical: false,
      };
      
      const { combatant: updated } = applyDamage(combatant, damage);
      
      expect(updated.deathSaves?.successes).toBe(0);
      expect(updated.deathSaves?.failures).toBe(0);
    });

    test('includes CRITICAL in description for critical hits', () => {
      const combatant = createCombatant();
      const damage: DamageInstance = {
        amount: 20,
        type: 'slashing',
        source: 'sword',
        isCritical: true,
      };
      
      const { result } = applyDamage(combatant, damage);
      
      expect(result.description).toContain('CRITICAL');
    });
  });

  // ============================================================================
  // TEMPORARY HP
  // ============================================================================
  describe('temporary HP', () => {
    test('absorbs damage before regular HP', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 10 } });
      const damage: DamageInstance = {
        amount: 5,
        type: 'bludgeoning',
        source: 'fist',
        isCritical: false,
      };
      
      const { combatant: updated, result } = applyDamage(combatant, damage);
      
      expect(updated.hp.temp).toBe(5);
      expect(updated.hp.current).toBe(30); // Unchanged
      expect(result.finalAmount).toBe(5);
    });

    test('overflow damage goes to regular HP', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 5 } });
      const damage: DamageInstance = {
        amount: 15,
        type: 'slashing',
        source: 'sword',
        isCritical: false,
      };
      
      const { combatant: updated } = applyDamage(combatant, damage);
      
      expect(updated.hp.temp).toBe(0);
      expect(updated.hp.current).toBe(20); // 30 - (15 - 5) = 20
    });

    test('temp HP completely absorbed with exact match', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 10 } });
      const damage: DamageInstance = {
        amount: 10,
        type: 'fire',
        source: 'torch',
        isCritical: false,
      };
      
      const { combatant: updated } = applyDamage(combatant, damage);
      
      expect(updated.hp.temp).toBe(0);
      expect(updated.hp.current).toBe(30);
    });
  });

  describe('applyTempHP', () => {
    test('sets temp HP', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 0 } });
      const updated = applyTempHP(combatant, 15);
      
      expect(updated.hp.temp).toBe(15);
      expect(updated.hp.current).toBe(30);
    });

    test('temp HP does not stack - takes higher', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 10 } });
      const updated = applyTempHP(combatant, 15);
      
      expect(updated.hp.temp).toBe(15);
    });

    test('lower temp HP does not replace higher', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 20 } });
      const updated = applyTempHP(combatant, 10);
      
      expect(updated.hp.temp).toBe(20);
    });
  });

  // ============================================================================
  // RESISTANCES, IMMUNITIES, VULNERABILITIES
  // ============================================================================
  describe('damage resistances', () => {
    test('resistance halves damage (rounded down)', () => {
      const combatant = createCombatant({
        hp: { current: 30, max: 50, temp: 0 },
        resistances: ['fire'],
      });
      const damage: DamageInstance = {
        amount: 15,
        type: 'fire',
        source: 'torch',
        isCritical: false,
      };
      
      const { combatant: updated, result } = applyDamage(combatant, damage);
      
      expect(result.finalAmount).toBe(7); // 15 / 2 = 7.5 -> 7
      expect(result.wasResisted).toBe(true);
      expect(updated.hp.current).toBe(23); // 30 - 7
    });

    test('resistance with odd damage rounds down', () => {
      const combatant = createCombatant({ resistances: ['cold'] });
      const damage: DamageInstance = {
        amount: 11,
        type: 'cold',
        source: 'frost',
        isCritical: false,
      };
      
      const { result } = applyDamage(combatant, damage);
      expect(result.finalAmount).toBe(5); // 11 / 2 = 5.5 -> 5
    });

    test('description mentions resistance', () => {
      const combatant = createCombatant({ resistances: ['fire'] });
      const damage: DamageInstance = {
        amount: 10,
        type: 'fire',
        source: 'flames',
        isCritical: false,
      };
      
      const { result } = applyDamage(combatant, damage);
      expect(result.description).toContain('resisted');
    });
  });

  describe('damage immunities', () => {
    test('immunity negates all damage', () => {
      const combatant = createCombatant({
        hp: { current: 30, max: 50, temp: 0 },
        immunities: ['poison'],
      });
      const damage: DamageInstance = {
        amount: 50,
        type: 'poison',
        source: 'venom',
        isCritical: false,
      };
      
      const { combatant: updated, result } = applyDamage(combatant, damage);
      
      expect(result.finalAmount).toBe(0);
      expect(result.wasImmune).toBe(true);
      expect(updated.hp.current).toBe(30); // Unchanged
    });

    test('description mentions immunity', () => {
      const combatant = createCombatant({ immunities: ['psychic'] });
      const damage: DamageInstance = {
        amount: 20,
        type: 'psychic',
        source: 'mind blast',
        isCritical: false,
      };
      
      const { result } = applyDamage(combatant, damage);
      expect(result.description).toContain('immune');
    });
  });

  describe('damage vulnerabilities', () => {
    test('vulnerability doubles damage', () => {
      const combatant = createCombatant({
        hp: { current: 30, max: 50, temp: 0 },
        vulnerabilities: ['fire'],
      });
      const damage: DamageInstance = {
        amount: 10,
        type: 'fire',
        source: 'flames',
        isCritical: false,
      };
      
      const { combatant: updated, result } = applyDamage(combatant, damage);
      
      expect(result.finalAmount).toBe(20);
      expect(result.wasVulnerable).toBe(true);
      expect(updated.hp.current).toBe(10); // 30 - 20
    });

    test('description mentions vulnerability', () => {
      const combatant = createCombatant({ vulnerabilities: ['radiant'] });
      const damage: DamageInstance = {
        amount: 8,
        type: 'radiant',
        source: 'holy light',
        isCritical: false,
      };
      
      const { result } = applyDamage(combatant, damage);
      expect(result.description).toContain('vulnerable');
      expect(result.description).toContain('doubled');
    });
  });

  // ============================================================================
  // INSTANT KILL (MASSIVE DAMAGE)
  // ============================================================================
  describe('instant kill from massive damage', () => {
    test('instant kill when damage >= current HP + max HP', () => {
      const combatant = createCombatant({
        type: 'pc',
        hp: { current: 20, max: 50, temp: 0 },
      });
      const damage: DamageInstance = {
        amount: 70, // 20 + 50 = 70
        type: 'bludgeoning',
        source: 'boulder',
        isCritical: false,
      };
      
      const { result } = applyDamage(combatant, damage);
      
      expect(result.instantKill).toBe(true);
      expect(result.description).toContain('INSTANT DEATH');
    });

    test('no instant kill for monsters', () => {
      const combatant = createCombatant({
        type: 'monster',
        hp: { current: 20, max: 50, temp: 0 },
      });
      const damage: DamageInstance = {
        amount: 100,
        type: 'force',
        source: 'disintegrate',
        isCritical: false,
      };
      
      const { result } = applyDamage(combatant, damage);
      
      expect(result.instantKill).toBe(false);
    });

    test('instant kill threshold exact boundary', () => {
      const combatant = createCombatant({
        type: 'pc',
        hp: { current: 10, max: 40, temp: 0 },
      });
      // Damage must be >= current (10) + max (40) = 50
      const justUnder: DamageInstance = { amount: 49, type: 'fire', source: 'test', isCritical: false };
      const exactMatch: DamageInstance = { amount: 50, type: 'fire', source: 'test', isCritical: false };
      
      const resultUnder = applyDamage(combatant, justUnder);
      expect(resultUnder.result.instantKill).toBe(false);
      
      // Reset combatant for second test
      const combatant2 = createCombatant({
        type: 'pc',
        hp: { current: 10, max: 40, temp: 0 },
      });
      const resultExact = applyDamage(combatant2, exactMatch);
      expect(resultExact.result.instantKill).toBe(true);
    });
  });

  // ============================================================================
  // MULTIPLE DAMAGE
  // ============================================================================
  describe('applyMultipleDamage', () => {
    test('applies multiple damage instances sequentially', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 0 } });
      const damages: DamageInstance[] = [
        { amount: 5, type: 'slashing', source: 'sword', isCritical: false },
        { amount: 8, type: 'fire', source: 'flames', isCritical: false },
      ];
      
      const { combatant: updated, results } = applyMultipleDamage(combatant, damages);
      
      expect(results.length).toBe(2);
      expect(updated.hp.current).toBe(17); // 30 - 5 - 8
    });

    test('stops processing after instant kill', () => {
      const combatant = createCombatant({
        type: 'pc',
        hp: { current: 10, max: 30, temp: 0 },
      });
      const damages: DamageInstance[] = [
        { amount: 40, type: 'force', source: 'disintegrate', isCritical: false }, // Instant kill
        { amount: 100, type: 'fire', source: 'never applied', isCritical: false },
      ];
      
      const { results } = applyMultipleDamage(combatant, damages);
      
      expect(results.length).toBe(1); // Second damage not applied
      expect(results[0].instantKill).toBe(true);
    });

    test('handles mixed resistances across damage types', () => {
      const combatant = createCombatant({
        hp: { current: 50, max: 50, temp: 0 },
        resistances: ['fire'],
        immunities: ['poison'],
      });
      const damages: DamageInstance[] = [
        { amount: 10, type: 'fire', source: 'test', isCritical: false },     // 5 after resistance
        { amount: 10, type: 'slashing', source: 'test', isCritical: false }, // 10 full
        { amount: 10, type: 'poison', source: 'test', isCritical: false },   // 0 immune
      ];
      
      const { combatant: updated, results } = applyMultipleDamage(combatant, damages);
      
      expect(results[0].wasResisted).toBe(true);
      expect(results[1].wasResisted).toBe(false);
      expect(results[2].wasImmune).toBe(true);
      expect(updated.hp.current).toBe(35); // 50 - 5 - 10 - 0
    });
  });

  // ============================================================================
  // HEALING
  // ============================================================================
  describe('applyHealing', () => {
    test('increases HP by healing amount', () => {
      const combatant = createCombatant({ hp: { current: 20, max: 50, temp: 0 } });
      
      const { combatant: updated, result } = applyHealing(combatant, 15, 'cure wounds');
      
      expect(updated.hp.current).toBe(35);
      expect(result.amount).toBe(15);
      expect(result.newHp).toBe(35);
      expect(result.overhealing).toBe(0);
    });

    test('cannot heal above max HP', () => {
      const combatant = createCombatant({ hp: { current: 45, max: 50, temp: 0 } });
      
      const { combatant: updated, result } = applyHealing(combatant, 20, 'heal');
      
      expect(updated.hp.current).toBe(50);
      expect(result.amount).toBe(5); // Only 5 actual healing
      expect(result.overhealing).toBe(15);
    });

    test('removes unconscious condition when healing from 0', () => {
      const combatant = createCombatant({
        hp: { current: 0, max: 50, temp: 0 },
        conditions: [{ condition: 'unconscious', sourceId: 'damage' }],
      });
      
      const { combatant: updated, result } = applyHealing(combatant, 10, 'healing word');
      
      expect(updated.hp.current).toBe(10);
      expect(result.wasUnconscious).toBe(true);
      expect(updated.conditions.some(c => c.condition === 'unconscious')).toBe(false);
      expect(result.description).toContain('regains consciousness');
    });

    test('resets death saves when healed from 0', () => {
      const combatant = createCombatant({
        hp: { current: 0, max: 50, temp: 0 },
        deathSaves: { successes: 2, failures: 2 },
      });
      
      const { combatant: updated } = applyHealing(combatant, 5, 'spare the dying');
      
      expect(updated.deathSaves?.successes).toBe(0);
      expect(updated.deathSaves?.failures).toBe(0);
    });

    test('healing at full HP shows overhealing', () => {
      const combatant = createCombatant({ hp: { current: 50, max: 50, temp: 0 } });
      
      const { result } = applyHealing(combatant, 10, 'heal');
      
      expect(result.amount).toBe(0);
      expect(result.overhealing).toBe(10);
    });
  });

  // ============================================================================
  // CONCENTRATION
  // ============================================================================
  describe('checkConcentration', () => {
    test('no check required without concentration', () => {
      const combatant = createCombatant({ concentratingOn: undefined });
      
      const { mustCheck, dc } = checkConcentration(combatant, 20);
      
      expect(mustCheck).toBe(false);
    });

    test('check required when concentrating', () => {
      const combatant = createCombatant({ concentratingOn: 'hold person' });
      
      const { mustCheck, dc } = checkConcentration(combatant, 10);
      
      expect(mustCheck).toBe(true);
    });

    test('DC is 10 for low damage', () => {
      const combatant = createCombatant({ concentratingOn: 'bless' });
      
      const { dc } = checkConcentration(combatant, 15);
      
      expect(dc).toBe(10); // 15/2 = 7.5, but minimum is 10
    });

    test('DC is half damage for high damage', () => {
      const combatant = createCombatant({ concentratingOn: 'fly' });
      
      const { dc } = checkConcentration(combatant, 40);
      
      expect(dc).toBe(20); // 40/2 = 20
    });

    test('DC rounds down', () => {
      const combatant = createCombatant({ concentratingOn: 'haste' });
      
      const { dc } = checkConcentration(combatant, 25);
      
      expect(dc).toBe(12); // 25/2 = 12.5 -> 12
    });
  });

  describe('breakConcentration', () => {
    test('removes concentration spell', () => {
      const combatant = createCombatant({ concentratingOn: 'hold monster' });
      
      const updated = breakConcentration(combatant);
      
      expect(updated.concentratingOn).toBeUndefined();
    });
  });

  // ============================================================================
  // DAMAGE WHILE DYING
  // ============================================================================
  describe('applyDamageWhileDying', () => {
    test('adds death save failure at 0 HP', () => {
      const combatant = createCombatant({
        hp: { current: 0, max: 50, temp: 0 },
        deathSaves: { successes: 0, failures: 0 },
      });
      const damage: DamageInstance = {
        amount: 5,
        type: 'slashing',
        source: 'sword',
        isCritical: false,
      };
      
      const updated = applyDamageWhileDying(combatant, damage);
      
      expect(updated.deathSaves?.failures).toBe(1);
    });

    test('critical hit adds 2 failures', () => {
      const combatant = createCombatant({
        hp: { current: 0, max: 50, temp: 0 },
        deathSaves: { successes: 0, failures: 0 },
      });
      const damage: DamageInstance = {
        amount: 10,
        type: 'piercing',
        source: 'arrow',
        isCritical: true,
      };
      
      const updated = applyDamageWhileDying(combatant, damage);
      
      expect(updated.deathSaves?.failures).toBe(2);
    });

    test('caps failures at 3', () => {
      const combatant = createCombatant({
        hp: { current: 0, max: 50, temp: 0 },
        deathSaves: { successes: 0, failures: 2 },
      });
      const damage: DamageInstance = {
        amount: 5,
        type: 'bludgeoning',
        source: 'club',
        isCritical: true, // Would add 2, but caps at 3
      };
      
      const updated = applyDamageWhileDying(combatant, damage);
      
      expect(updated.deathSaves?.failures).toBe(3);
    });

    test('does nothing if HP > 0', () => {
      const combatant = createCombatant({
        hp: { current: 5, max: 50, temp: 0 },
        deathSaves: { successes: 0, failures: 0 },
      });
      const damage: DamageInstance = {
        amount: 10,
        type: 'fire',
        source: 'flames',
        isCritical: false,
      };
      
      const updated = applyDamageWhileDying(combatant, damage);
      
      expect(updated.deathSaves?.failures).toBe(0);
    });
  });

  // ============================================================================
  // DAMAGE ROLLING
  // ============================================================================
  describe('rollDamage', () => {
    test('returns total and rolls', () => {
      const result = rollDamage('2d6+3');
      
      expect(result.rolls.length).toBe(2);
      expect(result.total).toBeGreaterThanOrEqual(5); // min 2 + 3
      expect(result.total).toBeLessThanOrEqual(15); // max 12 + 3
    });

    test('critical doubles dice', () => {
      const result = rollDamage('1d8+2', true);
      
      expect(result.rolls.length).toBe(2); // 1 * 2
      expect(result.expression).toContain('critical');
    });

    test('returns 0 for invalid expression', () => {
      const result = rollDamage('invalid');
      
      expect(result.total).toBe(0);
      expect(result.rolls).toEqual([]);
    });

    test('minimum total is 0 (negative modifier)', () => {
      // d4 can roll 1-4, with -10 would be negative
      // But we floor at 0
      for (let i = 0; i < 50; i++) {
        const result = rollDamage('1d4-10');
        expect(result.total).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('averageDamage', () => {
    test('calculates correct average for d6', () => {
      expect(averageDamage('2d6+3')).toBe(10); // 2 * 3.5 + 3 = 10
    });

    test('calculates correct average for d8', () => {
      expect(averageDamage('1d8+5')).toBe(9); // 4.5 + 5 = 9.5 -> 9
    });

    test('handles expression without modifier', () => {
      expect(averageDamage('4d4')).toBe(10); // 4 * 2.5 = 10
    });

    test('returns 0 for invalid expression', () => {
      expect(averageDamage('invalid')).toBe(0);
    });
  });

  // ============================================================================
  // DAMAGE DESCRIPTION
  // ============================================================================
  describe('describeDamage', () => {
    test('includes intensity level', () => {
      const minor = describeDamage(3, 'slashing', 'Goblin');
      const massive = describeDamage(25, 'fire', 'Dragon');
      
      expect(minor).toContain('minor');
      expect(massive).toContain('massive');
    });

    test('includes damage type verb', () => {
      const fire = describeDamage(10, 'fire', 'Target');
      const slash = describeDamage(10, 'slashing', 'Target');
      
      expect(fire).toMatch(/burn|scorch|ignite/i);
      expect(slash).toMatch(/slice|cut|rend/i);
    });

    test('includes target name', () => {
      const desc = describeDamage(15, 'bludgeoning', 'Orc Warrior');
      expect(desc).toContain('Orc Warrior');
    });

    test('categorizes damage intensity correctly', () => {
      // Test boundary values
      expect(describeDamage(4, 'fire', 'T')).toContain('minor');     // < 5
      expect(describeDamage(5, 'fire', 'T')).toContain('moderate');  // >= 5
      expect(describeDamage(10, 'fire', 'T')).toContain('solid');    // >= 10
      expect(describeDamage(15, 'fire', 'T')).toContain('significant'); // >= 15
      expect(describeDamage(20, 'fire', 'T')).toContain('massive');  // >= 20
      expect(describeDamage(30, 'fire', 'T')).toContain('devastating'); // >= 30
    });
  });

  // ============================================================================
  // EDGE CASES
  // ============================================================================
  describe('edge cases', () => {
    test('zero damage has no effect', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 0 } });
      const damage: DamageInstance = { amount: 0, type: 'slashing', source: 'test', isCritical: false };
      
      const { combatant: updated } = applyDamage(combatant, damage);
      expect(updated.hp.current).toBe(30);
    });

    test('zero healing has no effect', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 0 } });
      const { result } = applyHealing(combatant, 0, 'weak heal');
      expect(result.amount).toBe(0);
    });

    test('negative damage treated as 0', () => {
      const combatant = createCombatant({ hp: { current: 30, max: 50, temp: 0 } });
      const damage: DamageInstance = { amount: -5, type: 'slashing', source: 'test', isCritical: false };
      
      // Negative damage should not heal
      const { combatant: updated } = applyDamage(combatant, damage);
      // Implementation dependent - but HP should not increase
      expect(updated.hp.current).toBeLessThanOrEqual(30);
    });

    test('does not add duplicate unconscious condition', () => {
      const combatant = createCombatant({
        hp: { current: 5, max: 50, temp: 0 },
        conditions: [{ condition: 'unconscious', sourceId: 'existing' }],
      });
      const damage: DamageInstance = { amount: 10, type: 'slashing', source: 'test', isCritical: false };
      
      const { combatant: updated } = applyDamage(combatant, damage);
      const unconsciousCount = updated.conditions.filter(c => c.condition === 'unconscious').length;
      expect(unconsciousCount).toBe(1); // Should not duplicate
    });
  });
});
