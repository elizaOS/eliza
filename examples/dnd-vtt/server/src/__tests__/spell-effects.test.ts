/**
 * Tests for spell-effects.ts
 * Verifies that buff/utility spells apply real mechanical effects.
 */

import { describe, test, expect } from 'bun:test';
import { applySpellEffect } from '../combat/spell-effects';
import type { Combatant, CombatEncounter } from '../combat/combat-state';
import { getCondName } from '../combat/condition-utils';

function makeCombatant(id: string, overrides: Partial<Combatant> = {}): Combatant {
  return {
    id, name: `Combatant ${id}`, type: 'pc',
    initiative: 15, dexterityModifier: 2,
    wisdomModifier: 0,
    constitutionModifier: 0,
    hp: { current: 20, max: 20, temp: 0 }, ac: 15, speed: 30,
    conditions: [],
    turnResources: { actionUsed: false, bonusActionUsed: false, reactionUsed: false, movementRemaining: 30, freeObjectInteraction: true },
    sourceId: `src-${id}`, sourceType: 'character',
    ...overrides,
  };
}

function makeEncounter(combatants: Combatant[]): CombatEncounter {
  return {
    id: 'enc-1', campaignId: 'camp-1', sessionId: 'sess-1',
    status: 'active', round: 1, currentTurnIndex: 0,
    initiativeOrder: combatants, defeatedCombatants: [], fledCombatants: [],
    environmentalEffects: [], lightingCondition: 'bright',
    lairActionsAvailable: false, lairActionUsedThisRound: false,
    legendaryActionsRemaining: new Map(), actionLog: [], startedAt: new Date(),
  };
}

describe('Spell Effects', () => {
  describe('Shield', () => {
    test('increases caster AC by 5', () => {
      const caster = makeCombatant('caster', { ac: 12 });
      const enc = makeEncounter([caster]);
      const result = applySpellEffect('Shield', enc, caster, []);
      expect(result).not.toBeNull();
      const updated = result!.encounter.initiativeOrder.find(c => c.id === 'caster');
      expect(updated!.ac).toBe(17);
    });

    test('adds Shielded condition', () => {
      const caster = makeCombatant('caster');
      const result = applySpellEffect('Shield', makeEncounter([caster]), caster, []);
      const updated = result!.encounter.initiativeOrder[0];
      expect(updated.conditions.some(c => getCondName(c).toLowerCase() === 'shielded')).toBe(true);
    });

    test('description mentions AC', () => {
      const caster = makeCombatant('caster', { ac: 14 });
      const result = applySpellEffect('Shield', makeEncounter([caster]), caster, []);
      expect(result!.description).toContain('19'); // 14 + 5
    });
  });

  describe('Shield of Faith', () => {
    test('increases target AC by 2', () => {
      const caster = makeCombatant('caster');
      const target = makeCombatant('target', { ac: 16 });
      const enc = makeEncounter([caster, target]);
      const result = applySpellEffect('Shield of Faith', enc, caster, [target]);
      const updated = result!.encounter.initiativeOrder.find(c => c.id === 'target');
      expect(updated!.ac).toBe(18);
    });

    test('sets concentration on caster', () => {
      const caster = makeCombatant('caster');
      const target = makeCombatant('target');
      const result = applySpellEffect('Shield of Faith', makeEncounter([caster, target]), caster, [target]);
      const updatedCaster = result!.encounter.initiativeOrder.find(c => c.id === 'caster');
      expect(updatedCaster!.concentratingOn).toBe('Shield of Faith');
    });

    test('self-targets if no target provided', () => {
      const caster = makeCombatant('caster', { ac: 14 });
      const result = applySpellEffect('Shield of Faith', makeEncounter([caster]), caster, []);
      const updated = result!.encounter.initiativeOrder[0];
      expect(updated.ac).toBe(16);
    });
  });

  describe('Bless', () => {
    test('applies Blessed condition to up to 3 targets', () => {
      const caster = makeCombatant('caster');
      const t1 = makeCombatant('t1');
      const t2 = makeCombatant('t2');
      const t3 = makeCombatant('t3');
      const t4 = makeCombatant('t4');
      const enc = makeEncounter([caster, t1, t2, t3, t4]);
      const result = applySpellEffect('Bless', enc, caster, [t1, t2, t3, t4]);
      expect(result).not.toBeNull();
      // Only first 3 should be blessed
      const blessed = result!.encounter.initiativeOrder.filter(c =>
        c.conditions.some(cond => getCondName(cond).toLowerCase() === 'blessed')
      );
      expect(blessed.length).toBe(3);
    });

    test('sets concentration on caster', () => {
      const caster = makeCombatant('caster');
      const target = makeCombatant('target');
      const result = applySpellEffect('Bless', makeEncounter([caster, target]), caster, [target]);
      const updatedCaster = result!.encounter.initiativeOrder.find(c => c.id === 'caster');
      expect(updatedCaster!.concentratingOn).toBe('Bless');
    });
  });

  describe('Guidance', () => {
    test('applies Guidance condition to target', () => {
      const caster = makeCombatant('caster');
      const target = makeCombatant('target');
      const result = applySpellEffect('Guidance', makeEncounter([caster, target]), caster, [target]);
      const updated = result!.encounter.initiativeOrder.find(c => c.id === 'target');
      expect(updated!.conditions.some(c => getCondName(c).toLowerCase() === 'guided')).toBe(true);
    });

    test('self-targets if no target provided', () => {
      const caster = makeCombatant('caster');
      const result = applySpellEffect('Guidance', makeEncounter([caster]), caster, []);
      expect(result!.encounter.initiativeOrder[0].conditions.length).toBe(1);
    });
  });

  describe('Sleep', () => {
    test('puts low-HP enemies to sleep', () => {
      const caster = makeCombatant('caster', { type: 'pc' });
      const weakGoblin = makeCombatant('goblin', { type: 'monster', hp: { current: 3, max: 7, temp: 0 } });
      const enc = makeEncounter([caster, weakGoblin]);

      // Run multiple times since Sleep uses random dice
      let sleptCount = 0;
      for (let i = 0; i < 20; i++) {
        const result = applySpellEffect('Sleep', enc, caster, []);
        if (result!.description.includes('unconscious')) sleptCount++;
      }
      // 5d8 averages 22.5 HP, goblin has 3 HP. Should almost always succeed.
      expect(sleptCount).toBeGreaterThan(15);
    });

    test('does not affect allies', () => {
      const caster = makeCombatant('caster', { type: 'pc' });
      const ally = makeCombatant('ally', { type: 'pc', hp: { current: 3, max: 10, temp: 0 } });
      const result = applySpellEffect('Sleep', makeEncounter([caster, ally]), caster, []);
      // Ally is same type as caster, should not be targeted
      const allyAfter = result!.encounter.initiativeOrder.find(c => c.id === 'ally');
      expect(allyAfter!.conditions.length).toBe(0);
    });
  });

  describe('Spare the Dying', () => {
    test('stabilizes a dying creature', () => {
      const caster = makeCombatant('caster');
      const dying = makeCombatant('dying', { hp: { current: 0, max: 20, temp: 0 }, deathSaves: { successes: 1, failures: 2 } });
      const result = applySpellEffect('Spare the Dying', makeEncounter([caster, dying]), caster, [dying]);
      const updated = result!.encounter.initiativeOrder.find(c => c.id === 'dying');
      expect(updated!.deathSaves!.successes).toBe(3);
    });

    test('does nothing if target is not dying', () => {
      const caster = makeCombatant('caster');
      const healthy = makeCombatant('healthy');
      const result = applySpellEffect('Spare the Dying', makeEncounter([caster, healthy]), caster, [healthy]);
      expect(result!.description).toContain('not dying');
    });
  });

  describe('unknown spells', () => {
    test('returns null for unregistered spell names', () => {
      const caster = makeCombatant('caster');
      const result = applySpellEffect('Fireball', makeEncounter([caster]), caster, []);
      expect(result).toBeNull();
    });
  });
});
