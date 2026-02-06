/**
 * Tests for combat-manager.ts
 * Covers encounter lifecycle, endTurn condition cleanup, shouldCombatEnd.
 */

import { describe, test, expect } from 'bun:test';
import {
  createEncounter,
  addPartyToEncounter,
  startCombat,
  endTurn,
  updateCombatant,
  shouldCombatEnd,
  endCombat,
  getCombatSummary,
} from '../combat/combat-manager';
import type { Combatant, CombatEncounter } from '../combat/combat-state';
import type { CharacterSheet } from '../types';

// ── Test helpers ──

function createTestCombatant(overrides: Partial<Combatant> = {}): Combatant {
  return {
    id: overrides.id ?? 'test-combatant',
    name: overrides.name ?? 'Test Fighter',
    type: overrides.type ?? 'pc',
    initiative: overrides.initiative ?? 15,
    dexterityModifier: overrides.dexterityModifier ?? 2,
    wisdomModifier: overrides.wisdomModifier ?? 0,
    constitutionModifier: overrides.constitutionModifier ?? 0,
    hp: overrides.hp ?? { current: 20, max: 20, temp: 0 },
    ac: overrides.ac ?? 15,
    speed: overrides.speed ?? 30,
    conditions: overrides.conditions ?? [],
    turnResources: overrides.turnResources ?? {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementRemaining: 30,
      freeObjectInteraction: true,
    },
    sourceId: overrides.sourceId ?? 'char-1',
    sourceType: overrides.sourceType ?? 'character',
    ...overrides,
  };
}

function createTestEncounter(combatants: Combatant[]): CombatEncounter {
  return {
    id: 'enc-1',
    campaignId: 'camp-1',
    sessionId: 'sess-1',
    status: 'active',
    round: 1,
    currentTurnIndex: 0,
    initiativeOrder: combatants,
    defeatedCombatants: [],
    fledCombatants: [],
    environmentalEffects: [],
    lightingCondition: 'bright',
    lairActionsAvailable: false,
    lairActionUsedThisRound: false,
    legendaryActionsRemaining: new Map(),
    actionLog: [],
    startedAt: new Date(),
  };
}


describe('Combat Manager', () => {

  // ═══════════════════════════════════════════════════
  // ENCOUNTER LIFECYCLE
  // ═══════════════════════════════════════════════════

  describe('createEncounter', () => {
    test('creates encounter with correct initial state', () => {
      const enc = createEncounter('camp-1', 'sess-1');
      expect(enc.status).toBe('preparing');
      expect(enc.round).toBe(0);
      expect(enc.currentTurnIndex).toBe(0);
      expect(enc.initiativeOrder).toEqual([]);
      expect(enc.defeatedCombatants).toEqual([]);
    });

    test('accepts optional battle map and lighting', () => {
      const enc = createEncounter('camp-1', 'sess-1', {
        battleMapId: 'map-1',
        lightingCondition: 'dim',
      });
      expect(enc.battleMapId).toBe('map-1');
      expect(enc.lightingCondition).toBe('dim');
    });
  });

  describe('startCombat', () => {
    test('sorts combatants by initiative descending', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'low', initiative: 5 }),
        createTestCombatant({ id: 'high', initiative: 20 }),
        createTestCombatant({ id: 'mid', initiative: 12 }),
      ]);
      const started = startCombat({ ...enc, status: 'preparing', round: 0 });
      expect(started.initiativeOrder[0].id).toBe('high');
      expect(started.initiativeOrder[1].id).toBe('mid');
      expect(started.initiativeOrder[2].id).toBe('low');
    });

    test('breaks ties by dexterity modifier', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'low-dex', initiative: 15, dexterityModifier: 1 }),
        createTestCombatant({ id: 'high-dex', initiative: 15, dexterityModifier: 3 }),
      ]);
      const started = startCombat({ ...enc, status: 'preparing', round: 0 });
      expect(started.initiativeOrder[0].id).toBe('high-dex');
    });

    test('sets status to active and round to 1', () => {
      const enc = createTestEncounter([createTestCombatant()]);
      const started = startCombat({ ...enc, status: 'preparing', round: 0 });
      expect(started.status).toBe('active');
      expect(started.round).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════
  // END TURN + CONDITION CLEANUP
  // ═══════════════════════════════════════════════════

  describe('endTurn', () => {
    test('advances to next combatant', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'a', name: 'A' }),
        createTestCombatant({ id: 'b', name: 'B' }),
      ]);
      const after = endTurn(enc);
      expect(after.currentTurnIndex).toBe(1);
    });

    test('wraps around to first combatant and increments round', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'a' }),
        createTestCombatant({ id: 'b' }),
      ]);
      const afterFirst = endTurn(enc);
      const afterSecond = endTurn(afterFirst);
      expect(afterSecond.currentTurnIndex).toBe(0);
      expect(afterSecond.round).toBe(2);
    });

    test('removes turn-based conditions with type "turns" and endsAt "start_of_turn"', () => {
      const dodging = createTestCombatant({
        id: 'dodger',
        conditions: [{
          condition: 'dodging' as never,
          name: 'Dodging' as never,
          source: 'Dodge',
          duration: { type: 'turns', value: 1, endsAt: 'start_of_turn' },
        }],
      });
      const other = createTestCombatant({ id: 'other' });
      const enc = createTestEncounter([other, dodging]);
      // End other's turn → advances to dodger → start_of_turn cleanup removes Dodging
      const after = endTurn(enc);
      const dodgerAfter = after.initiativeOrder.find(c => c.id === 'dodger');
      expect(dodgerAfter!.conditions.length).toBe(0);
    });

    test('removes numeric duration conditions at end of turn', () => {
      const enc = createTestEncounter([
        createTestCombatant({
          id: 'temp-cond',
          conditions: [{
            condition: 'blessed' as never,
            name: 'Blessed' as never,
            source: 'Cleric',
            duration: 1,
          }],
        }),
        createTestCombatant({ id: 'other' }),
      ]);
      const after = endTurn(enc);
      const tempCondAfter = after.initiativeOrder.find(c => c.id === 'temp-cond');
      expect(tempCondAfter!.conditions.length).toBe(0);
    });

    test('preserves permanent conditions', () => {
      const enc = createTestEncounter([
        createTestCombatant({
          id: 'cursed',
          conditions: [{
            condition: 'poisoned' as never,
            name: 'Poisoned' as never,
            source: 'Trap',
            duration: { type: 'permanent' },
          }],
        }),
        createTestCombatant({ id: 'other' }),
      ]);
      const after = endTurn(enc);
      const cursedAfter = after.initiativeOrder.find(c => c.id === 'cursed');
      expect(cursedAfter!.conditions.length).toBe(1);
    });

    test('preserves "until_save" conditions', () => {
      const enc = createTestEncounter([
        createTestCombatant({
          id: 'held',
          conditions: [{
            condition: 'paralyzed' as never,
            name: 'Paralyzed' as never,
            source: 'Hold Person',
            duration: { type: 'until_save', saveDC: 15, saveAbility: 'wisdom' },
          }],
        }),
        createTestCombatant({ id: 'other' }),
      ]);
      const after = endTurn(enc);
      const heldAfter = after.initiativeOrder.find(c => c.id === 'held');
      expect(heldAfter!.conditions.length).toBe(1);
    });

    test('preserves "rounds" conditions (handled at round boundary, not turn)', () => {
      const enc = createTestEncounter([
        createTestCombatant({
          id: 'blessed',
          conditions: [{
            condition: 'blessed' as never,
            name: 'Blessed' as never,
            source: 'Cleric',
            duration: { type: 'rounds', roundsRemaining: 3 },
          }],
        }),
        createTestCombatant({ id: 'other' }),
      ]);
      const after = endTurn(enc);
      const blessedAfter = after.initiativeOrder.find(c => c.id === 'blessed');
      expect(blessedAfter!.conditions.length).toBe(1);
    });

    test('skips dead combatants', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'alive-1' }),
        createTestCombatant({ id: 'dead', type: 'monster', hp: { current: 0, max: 10, temp: 0 } }),
        createTestCombatant({ id: 'alive-2' }),
      ]);
      const after = endTurn(enc);
      // Should skip dead monster and go to alive-2
      expect(after.currentTurnIndex).toBe(2);
    });
  });

  // ═══════════════════════════════════════════════════
  // SHOULD COMBAT END
  // ═══════════════════════════════════════════════════

  describe('shouldCombatEnd', () => {
    test('returns false when both sides have active combatants', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'pc', type: 'pc', hp: { current: 20, max: 20, temp: 0 } }),
        createTestCombatant({ id: 'mob', type: 'monster', hp: { current: 10, max: 10, temp: 0 } }),
      ]);
      expect(shouldCombatEnd(enc).shouldEnd).toBe(false);
    });

    test('returns true when all enemies defeated', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'pc', type: 'pc', hp: { current: 20, max: 20, temp: 0 } }),
        createTestCombatant({ id: 'mob', type: 'monster', hp: { current: 0, max: 10, temp: 0 } }),
      ]);
      const result = shouldCombatEnd(enc);
      expect(result.shouldEnd).toBe(true);
      expect(result.reason).toBe('all_enemies_defeated');
      expect(result.winners).toBe('party');
    });

    test('returns true when all party defeated', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'pc', type: 'pc', hp: { current: 0, max: 20, temp: 0 } }),
        createTestCombatant({ id: 'mob', type: 'monster', hp: { current: 10, max: 10, temp: 0 } }),
      ]);
      const result = shouldCombatEnd(enc);
      expect(result.shouldEnd).toBe(true);
      expect(result.reason).toBe('all_party_defeated');
      expect(result.winners).toBe('enemies');
    });

    test('returns false with no enemies (edge case)', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'pc', type: 'pc' }),
      ]);
      expect(shouldCombatEnd(enc).shouldEnd).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════
  // END COMBAT + SUMMARY
  // ═══════════════════════════════════════════════════

  describe('endCombat', () => {
    test('sets status to ended', () => {
      const enc = createTestEncounter([createTestCombatant()]);
      const ended = endCombat(enc, 'All enemies defeated');
      expect(ended.status).toBe('ended');
      expect(ended.endedAt).toBeDefined();
    });

    test('adds system log entry with reason', () => {
      const enc = createTestEncounter([createTestCombatant()]);
      const ended = endCombat(enc, 'Party fled');
      const lastLog = ended.actionLog[ended.actionLog.length - 1];
      expect(lastLog.actorName).toBe('Combat');
      expect(lastLog.outcome).toBe('Party fled');
    });
  });

  describe('getCombatSummary', () => {
    test('counts defeated enemies', () => {
      const enc: CombatEncounter = {
        ...createTestEncounter([createTestCombatant({ id: 'pc', type: 'pc' })]),
        defeatedCombatants: [
          createTestCombatant({ id: 'mob1', name: 'Goblin 1', type: 'monster' }),
          createTestCombatant({ id: 'mob2', name: 'Goblin 2', type: 'monster' }),
        ],
      };
      const summary = getCombatSummary(enc);
      expect(summary.casualties.enemies).toEqual(['Goblin 1', 'Goblin 2']);
      expect(summary.casualties.party).toEqual([]);
    });

    test('counts party casualties', () => {
      const enc: CombatEncounter = {
        ...createTestEncounter([createTestCombatant({ id: 'mob', type: 'monster' })]),
        defeatedCombatants: [
          createTestCombatant({ id: 'pc1', name: 'Fallen Hero', type: 'pc' }),
        ],
      };
      const summary = getCombatSummary(enc);
      expect(summary.casualties.party).toEqual(['Fallen Hero']);
    });
  });

  // ═══════════════════════════════════════════════════
  // UPDATE COMBATANT
  // ═══════════════════════════════════════════════════

  describe('updateCombatant', () => {
    test('updates HP of a specific combatant', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'target', hp: { current: 20, max: 20, temp: 0 } }),
        createTestCombatant({ id: 'other' }),
      ]);
      const updated = updateCombatant(enc, {
        ...enc.initiativeOrder[0],
        hp: { current: 5, max: 20, temp: 0 },
      });
      expect(updated.initiativeOrder[0].hp.current).toBe(5);
      expect(updated.initiativeOrder[1].id).toBe('other'); // unchanged
    });

    test('removes defeated monster from initiative and adds to defeated list', () => {
      const enc = createTestEncounter([
        createTestCombatant({ id: 'pc', type: 'pc' }),
        createTestCombatant({ id: 'mob', type: 'monster', hp: { current: 10, max: 10, temp: 0 } }),
      ]);
      const updated = updateCombatant(enc, {
        ...enc.initiativeOrder[1],
        hp: { current: 0, max: 10, temp: 0 },
      });
      expect(updated.initiativeOrder.length).toBe(1);
      expect(updated.defeatedCombatants.length).toBe(1);
      expect(updated.defeatedCombatants[0].id).toBe('mob');
    });

    test('returns unchanged encounter for nonexistent combatant', () => {
      const enc = createTestEncounter([createTestCombatant({ id: 'a' })]);
      const updated = updateCombatant(enc, createTestCombatant({ id: 'nonexistent' }));
      expect(updated).toBe(enc); // same reference
    });
  });
});
