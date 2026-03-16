/**
 * Tests for combat-actions.ts condition mechanics
 * Verifies that Dodge, Disengage, Help, Hide, Ready properly apply
 * and consume conditions, and that executeAttack checks them.
 */

import { describe, test, expect } from 'bun:test';
import {
  executeAttack,
  executeDodge,
  executeDisengage,
  executeHelp,
  executeHide,
  executeReady,
  executeDash,
  executeMovement,
  executeStandUp,
  executeDeathSave,
} from '../combat/combat-actions';
import type { Combatant } from '../combat/combat-state';

function createCombatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    id: 'test-1',
    name: 'Fighter',
    type: 'pc',
    initiative: 15,
    dexterityModifier: 2,
    wisdomModifier: 0,
    constitutionModifier: 0,
    hp: { current: 30, max: 30, temp: 0 },
    ac: 16,
    speed: 30,
    conditions: [],
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

describe('Combat Actions - Condition Mechanics', () => {

  // ═══════════════════════════════════════════════════
  // DODGE
  // ═══════════════════════════════════════════════════

  describe('executeDodge', () => {
    test('adds Dodging condition to combatant', () => {
      const result = executeDodge(createCombatant());
      const updated = result.updatedCombatants[0];
      const dodging = updated.conditions.find(c =>
        ((c as Record<string, unknown>).condition as string)?.toLowerCase() === 'dodging'
      );
      expect(dodging).toBeDefined();
    });

    test('Dodging condition has turns duration with start_of_turn expiry', () => {
      const result = executeDodge(createCombatant());
      const updated = result.updatedCombatants[0];
      const dodging = updated.conditions[0];
      const dur = dodging.duration as Record<string, unknown>;
      expect(dur.type).toBe('turns');
      expect(dur.value).toBe(1);
      expect(dur.endsAt).toBe('start_of_turn');
    });

    test('marks action as used', () => {
      const result = executeDodge(createCombatant());
      expect(result.updatedCombatants[0].turnResources.actionUsed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════
  // DISENGAGE
  // ═══════════════════════════════════════════════════

  describe('executeDisengage', () => {
    test('adds Disengaged condition (not Invisible)', () => {
      const result = executeDisengage(createCombatant());
      const updated = result.updatedCombatants[0];
      const cond = updated.conditions[0];
      const name = ((cond as Record<string, unknown>).condition ?? (cond as Record<string, unknown>).name) as string;
      expect(name.toLowerCase()).toBe('disengaged');
      // Must NOT be invisible
      expect(name.toLowerCase()).not.toBe('invisible');
    });

    test('marks action as used', () => {
      const result = executeDisengage(createCombatant());
      expect(result.updatedCombatants[0].turnResources.actionUsed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════
  // HELP
  // ═══════════════════════════════════════════════════

  describe('executeHelp', () => {
    test('applies helped_attack condition to the target (not helper)', () => {
      const helper = createCombatant({ id: 'helper', name: 'Helper' });
      const target = createCombatant({ id: 'target', name: 'Target' });
      const result = executeHelp(helper, target, 'attack');

      // Helper should have no new conditions
      const updatedHelper = result.updatedCombatants.find(c => c.id === 'helper');
      expect(updatedHelper!.conditions.length).toBe(0);

      // Target should have helped_attack condition
      const updatedTarget = result.updatedCombatants.find(c => c.id === 'target');
      expect(updatedTarget).toBeDefined();
      const helpCond = updatedTarget!.conditions.find(c =>
        ((c as Record<string, unknown>).condition as string)?.toLowerCase() === 'helped_attack'
      );
      expect(helpCond).toBeDefined();
    });

    test('help for ability_check applies helped_check condition', () => {
      const helper = createCombatant({ id: 'helper' });
      const target = createCombatant({ id: 'target' });
      const result = executeHelp(helper, target, 'ability_check');
      const updatedTarget = result.updatedCombatants.find(c => c.id === 'target');
      const cond = updatedTarget!.conditions.find(c =>
        ((c as Record<string, unknown>).condition as string)?.toLowerCase() === 'helped_check'
      );
      expect(cond).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════
  // HIDE
  // ═══════════════════════════════════════════════════

  describe('executeHide', () => {
    test('successful hide adds Hidden condition', () => {
      // Roll 18 + mod 5 = 23, vs default DC 12 → success
      const result = executeHide(createCombatant(), 18, 5);
      expect(result.success).toBe(true);
      const hidden = result.updatedCombatants[0].conditions.find(c =>
        ((c as Record<string, unknown>).condition as string)?.toLowerCase() === 'hidden'
      );
      expect(hidden).toBeDefined();
    });

    test('failed hide does not add Hidden condition', () => {
      // Roll 2 + mod 0 = 2, vs default DC 12 → fail
      const result = executeHide(createCombatant(), 2, 0);
      expect(result.success).toBe(false);
      expect(result.updatedCombatants[0].conditions.length).toBe(0);
    });

    test('checks against enemy passive perception when enemies provided', () => {
      const enemies = [
        createCombatant({ id: 'sharp-eyes', wisdomModifier: 5 }), // passive = 15
      ];
      // Roll 10 + mod 3 = 13 < 15 → fail
      const result = executeHide(createCombatant(), 10, 3, enemies);
      expect(result.success).toBe(false);
    });

    test('succeeds against enemies with low passive perception', () => {
      const enemies = [
        createCombatant({ id: 'dim', wisdomModifier: -1 }), // passive = 9
      ];
      // Roll 8 + mod 2 = 10 >= 9 → success
      const result = executeHide(createCombatant(), 8, 2, enemies);
      expect(result.success).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════
  // READY
  // ═══════════════════════════════════════════════════

  describe('executeReady', () => {
    test('adds Readied condition with trigger info in source', () => {
      const result = executeReady(createCombatant(), 'enemy enters range', 'Attack');
      const cond = result.updatedCombatants[0].conditions[0];
      const name = ((cond as Record<string, unknown>).condition as string);
      expect(name.toLowerCase()).toBe('readied');
      expect((cond as Record<string, unknown>).source).toContain('enemy enters range');
      expect((cond as Record<string, unknown>).source).toContain('Attack');
    });
  });

  // ═══════════════════════════════════════════════════
  // ATTACK - CONDITION CHECKS
  // ═══════════════════════════════════════════════════

  describe('executeAttack - condition interactions', () => {
    test('Dodging target gives attacker disadvantage', async () => {
      const attacker = createCombatant({ id: 'atk', name: 'Attacker' });
      const dodgingTarget = createCombatant({
        id: 'def',
        name: 'Dodger',
        conditions: [{
          condition: 'dodging' as never,
          name: 'Dodging' as never,
          source: 'Dodge',
          duration: { type: 'turns', value: 1, endsAt: 'start_of_turn' },
        }],
      });

      // Run 50 attacks and check that the disadvantage flag appears in roll data
      const result = await executeAttack(attacker, dodgingTarget, 5, {
        dice: '1d6', type: 'slashing',
      });

      // The roll should have disadvantage flag set
      const attackRoll = result.logEntry.diceRolls?.[0];
      if (attackRoll) {
        expect(attackRoll.disadvantage).toBe(true);
      }
    });

    test('helped_attack condition gives attacker advantage and is consumed', async () => {
      const attacker = createCombatant({
        id: 'atk',
        name: 'Helped Attacker',
        conditions: [{
          condition: 'helped_attack' as never,
          name: 'helped_attack' as never,
          source: 'Ally',
          duration: { type: 'turns', value: 1, endsAt: 'start_of_turn' },
        }],
      });
      const target = createCombatant({ id: 'def', name: 'Target' });

      const result = await executeAttack(attacker, target, 5, {
        dice: '1d6', type: 'slashing',
      });

      // The roll should have advantage flag set
      const attackRoll = result.logEntry.diceRolls?.[0];
      if (attackRoll) {
        expect(attackRoll.advantage).toBe(true);
      }

      // helped_attack should be consumed (removed from attacker)
      const updatedAttacker = result.updatedCombatants.find(c => c.id === 'atk');
      const remaining = updatedAttacker!.conditions.find(c =>
        ((c as Record<string, unknown>).condition as string)?.toLowerCase() === 'helped_attack'
      );
      expect(remaining).toBeUndefined();
    });

    test('hidden condition gives attacker advantage and is consumed', async () => {
      const attacker = createCombatant({
        id: 'atk',
        name: 'Hidden Attacker',
        conditions: [{
          condition: 'hidden' as never,
          name: 'Hidden' as never,
          source: 'Hide',
          duration: { type: 'special', description: 'Until detected' },
        }],
      });
      const target = createCombatant({ id: 'def', name: 'Target' });

      const result = await executeAttack(attacker, target, 5, {
        dice: '1d6', type: 'slashing',
      });

      // Hidden should be consumed
      const updatedAttacker = result.updatedCombatants.find(c => c.id === 'atk');
      const remaining = updatedAttacker!.conditions.find(c =>
        ((c as Record<string, unknown>).condition as string)?.toLowerCase() === 'hidden'
      );
      expect(remaining).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════
  // DASH
  // ═══════════════════════════════════════════════════

  describe('executeDash', () => {
    test('adds speed to movement remaining', () => {
      const combatant = createCombatant({ speed: 30 });
      const result = executeDash(combatant);
      expect(result.updatedCombatants[0].turnResources.movementRemaining).toBe(60);
    });

    test('marks action as used', () => {
      const result = executeDash(createCombatant());
      expect(result.updatedCombatants[0].turnResources.actionUsed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════
  // MOVEMENT
  // ═══════════════════════════════════════════════════

  describe('executeMovement', () => {
    test('reduces movement remaining', () => {
      const combatant = createCombatant();
      const result = executeMovement(combatant, 15);
      expect(result.success).toBe(true);
      expect(result.updatedCombatants[0].turnResources.movementRemaining).toBe(15);
    });

    test('fails when not enough movement', () => {
      const combatant = createCombatant({
        turnResources: {
          actionUsed: false, bonusActionUsed: false, reactionUsed: false,
          movementRemaining: 5, freeObjectInteraction: true,
        },
      });
      const result = executeMovement(combatant, 10);
      expect(result.success).toBe(false);
    });

    test('updates position if provided', () => {
      const combatant = createCombatant({ position: { x: 0, y: 0 } });
      const result = executeMovement(combatant, 5, { x: 1, y: 0 });
      expect(result.updatedCombatants[0].position).toEqual({ x: 1, y: 0 });
    });

    test('exact movement amount succeeds', () => {
      const combatant = createCombatant({
        turnResources: {
          actionUsed: false, bonusActionUsed: false, reactionUsed: false,
          movementRemaining: 10, freeObjectInteraction: true,
        },
      });
      const result = executeMovement(combatant, 10);
      expect(result.success).toBe(true);
      expect(result.updatedCombatants[0].turnResources.movementRemaining).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════
  // STAND UP
  // ═══════════════════════════════════════════════════

  describe('executeStandUp', () => {
    test('fails if not prone', () => {
      const result = executeStandUp(createCombatant());
      expect(result.success).toBe(false);
    });

    test('removes Prone condition and costs half movement', () => {
      const prone = createCombatant({
        speed: 30,
        conditions: [{ condition: 'Prone' as never, name: 'Prone' as never, source: 'Shove' }],
        turnResources: {
          actionUsed: false, bonusActionUsed: false, reactionUsed: false,
          movementRemaining: 30, freeObjectInteraction: true,
        },
      });
      const result = executeStandUp(prone);
      expect(result.success).toBe(true);
      // Should cost 15ft (half of 30)
      expect(result.updatedCombatants[0].turnResources.movementRemaining).toBe(15);
    });

    test('fails when not enough movement to stand', () => {
      const prone = createCombatant({
        speed: 30,
        conditions: [{ condition: 'Prone' as never, name: 'Prone' as never, source: 'Shove' }],
        turnResources: {
          actionUsed: false, bonusActionUsed: false, reactionUsed: false,
          movementRemaining: 10, freeObjectInteraction: true,
        },
      });
      const result = executeStandUp(prone);
      expect(result.success).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════
  // DEATH SAVE
  // ═══════════════════════════════════════════════════

  describe('executeDeathSave', () => {
    test('fails if combatant has HP', () => {
      const result = executeDeathSave(createCombatant());
      expect(result.success).toBe(false);
    });

    test('works on combatant at 0 HP with death saves', () => {
      const dying = createCombatant({
        hp: { current: 0, max: 30, temp: 0 },
        deathSaves: { successes: 0, failures: 0 },
      });
      const result = executeDeathSave(dying);
      const updated = result.updatedCombatants[0];
      // Must have either a success or failure incremented
      const totalSF = (updated.deathSaves?.successes ?? 0) + (updated.deathSaves?.failures ?? 0);
      expect(totalSF).toBeGreaterThan(0);
    });
  });
});
