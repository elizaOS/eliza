/**
 * Tests for initiative-tracker.ts
 * Covers initiative rolling, turn advancement, delay, add/remove.
 */

import { describe, test, expect } from 'bun:test';
import {
  rollInitiative,
  rollGroupInitiative,
  setInitiativeOrder,
  addToInitiative,
  removeFromInitiative,
  getCurrentCombatant,
  advanceTurn,
  delayTurn,
  formatInitiativeOrder,
} from '../combat/initiative-tracker';
import type { Combatant, CombatEncounter } from '../combat/combat-state';

function makeCombatant(id: string, init: number, dexMod: number = 0, overrides: Partial<Combatant> = {}): Combatant {
  return {
    id,
    name: `Combatant ${id}`,
    type: 'pc',
    initiative: init,
    dexterityModifier: dexMod,
    wisdomModifier: 0,
    constitutionModifier: 0,
    hp: { current: 20, max: 20, temp: 0 },
    ac: 15,
    speed: 30,
    conditions: [],
    turnResources: {
      actionUsed: false,
      bonusActionUsed: false,
      reactionUsed: false,
      movementRemaining: 30,
      freeObjectInteraction: true,
    },
    sourceId: `src-${id}`,
    sourceType: 'character',
    ...overrides,
  };
}

function makeEncounter(combatants: Combatant[], currentIndex = 0): CombatEncounter {
  return {
    id: 'enc-test',
    campaignId: 'camp-1',
    sessionId: 'sess-1',
    status: 'active',
    round: 1,
    currentTurnIndex: currentIndex,
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


describe('Initiative Tracker', () => {

  // ═══════════════════════════════════════════════════
  // ROLL INITIATIVE
  // ═══════════════════════════════════════════════════

  describe('rollInitiative', () => {
    test('returns a roll between 1 and 20 (before modifier)', () => {
      const c = makeCombatant('a', 0, 3);
      for (let i = 0; i < 100; i++) {
        const result = rollInitiative(c);
        expect(result.roll).toBeGreaterThanOrEqual(1);
        expect(result.roll).toBeLessThanOrEqual(20);
      }
    });

    test('total = roll + dex modifier', () => {
      const c = makeCombatant('a', 0, 3);
      const result = rollInitiative(c);
      expect(result.total).toBe(result.roll + 3);
    });

    test('negative modifier reduces total', () => {
      const c = makeCombatant('a', 0, -2);
      const result = rollInitiative(c);
      expect(result.total).toBe(result.roll - 2);
    });

    test('advantage rolls twice and takes higher', () => {
      const c = makeCombatant('a', 0, 0);
      // Run many times to statistically confirm advantage gives higher results
      let advantageSum = 0;
      let normalSum = 0;
      const trials = 1000;
      for (let i = 0; i < trials; i++) {
        advantageSum += rollInitiative(c, true).roll;
        normalSum += rollInitiative(c, false).roll;
      }
      // Advantage average should be noticeably higher (~13.8 vs ~10.5)
      expect(advantageSum / trials).toBeGreaterThan(normalSum / trials);
    });
  });

  describe('rollGroupInitiative', () => {
    test('returns one roll per combatant', () => {
      const combatants = [makeCombatant('a', 0), makeCombatant('b', 0), makeCombatant('c', 0)];
      const rolls = rollGroupInitiative(combatants);
      expect(rolls.length).toBe(3);
    });

    test('results are sorted by total descending', () => {
      const combatants = [makeCombatant('a', 0), makeCombatant('b', 0), makeCombatant('c', 0)];
      const rolls = rollGroupInitiative(combatants);
      for (let i = 1; i < rolls.length; i++) {
        expect(rolls[i - 1].total).toBeGreaterThanOrEqual(rolls[i].total);
      }
    });
  });

  // ═══════════════════════════════════════════════════
  // SET INITIATIVE ORDER
  // ═══════════════════════════════════════════════════

  describe('setInitiativeOrder', () => {
    test('assigns initiative from rolls and sorts', () => {
      const combatants = [makeCombatant('a', 0, 1), makeCombatant('b', 0, 2)];
      const rolls = [
        { combatantId: 'a', combatantName: 'A', roll: 10, modifier: 1, total: 11 },
        { combatantId: 'b', combatantName: 'B', roll: 15, modifier: 2, total: 17 },
      ];
      const ordered = setInitiativeOrder(combatants, rolls);
      expect(ordered[0].id).toBe('b'); // higher initiative
      expect(ordered[0].initiative).toBe(17);
      expect(ordered[1].id).toBe('a');
      expect(ordered[1].initiative).toBe(11);
    });
  });

  // ═══════════════════════════════════════════════════
  // ADD / REMOVE FROM INITIATIVE
  // ═══════════════════════════════════════════════════

  describe('addToInitiative', () => {
    test('inserts at correct position based on initiative value', () => {
      const order = [
        makeCombatant('a', 20),
        makeCombatant('b', 10),
      ];
      const newGuy = makeCombatant('c', 0);
      const result = addToInitiative(order, newGuy, 15);
      expect(result[0].id).toBe('a'); // 20
      expect(result[1].id).toBe('c'); // 15
      expect(result[2].id).toBe('b'); // 10
    });

    test('inserts at end if lowest initiative', () => {
      const order = [makeCombatant('a', 20), makeCombatant('b', 10)];
      const result = addToInitiative(order, makeCombatant('c', 0), 5);
      expect(result[2].id).toBe('c');
    });

    test('inserts at beginning if highest initiative', () => {
      const order = [makeCombatant('a', 15), makeCombatant('b', 10)];
      const result = addToInitiative(order, makeCombatant('c', 0), 20);
      expect(result[0].id).toBe('c');
    });
  });

  describe('removeFromInitiative', () => {
    test('removes the specified combatant', () => {
      const order = [makeCombatant('a', 20), makeCombatant('b', 15), makeCombatant('c', 10)];
      const { newOrder, removed } = removeFromInitiative(order, 'b');
      expect(newOrder.length).toBe(2);
      expect(removed?.id).toBe('b');
      expect(newOrder.find(c => c.id === 'b')).toBeUndefined();
    });

    test('returns same order if combatant not found', () => {
      const order = [makeCombatant('a', 20)];
      const { newOrder, removed } = removeFromInitiative(order, 'nonexistent');
      expect(newOrder.length).toBe(1);
      expect(removed).toBeUndefined();
    });
  });

  // ═══════════════════════════════════════════════════
  // TURN ADVANCEMENT
  // ═══════════════════════════════════════════════════

  describe('getCurrentCombatant', () => {
    test('returns the combatant at current turn index', () => {
      const enc = makeEncounter([makeCombatant('a', 20), makeCombatant('b', 10)], 0);
      expect(getCurrentCombatant(enc)?.id).toBe('a');
    });

    test('returns null for empty encounter', () => {
      const enc = makeEncounter([], 0);
      expect(getCurrentCombatant(enc)).toBeNull();
    });

    test('returns null if index out of bounds', () => {
      const enc = makeEncounter([makeCombatant('a', 20)], 5);
      expect(getCurrentCombatant(enc)).toBeNull();
    });
  });

  describe('advanceTurn', () => {
    test('moves to next combatant', () => {
      const enc = makeEncounter([
        makeCombatant('a', 20),
        makeCombatant('b', 15),
        makeCombatant('c', 10),
      ], 0);
      const next = advanceTurn(enc);
      expect(next.currentTurnIndex).toBe(1);
    });

    test('wraps around and increments round', () => {
      const enc = makeEncounter([
        makeCombatant('a', 20),
        makeCombatant('b', 15),
      ], 1); // b's turn
      const next = advanceTurn(enc);
      expect(next.currentTurnIndex).toBe(0);
      expect(next.round).toBe(2);
    });

    test('skips dead combatants', () => {
      const enc = makeEncounter([
        makeCombatant('a', 20),
        makeCombatant('dead', 15, 0, {
          type: 'monster',
          hp: { current: 0, max: 10, temp: 0 },
        }),
        makeCombatant('c', 10),
      ], 0);
      const next = advanceTurn(enc);
      expect(next.currentTurnIndex).toBe(2); // Skipped dead
    });

    test('resets turn resources for the new current combatant', () => {
      const a = makeCombatant('a', 20);
      a.turnResources.actionUsed = true;
      a.turnResources.movementRemaining = 0;
      const enc = makeEncounter([a, makeCombatant('b', 15)], 1);
      const next = advanceTurn(enc);
      // Should wrap to a and reset their resources
      const updatedA = next.initiativeOrder[0];
      expect(updatedA.turnResources.actionUsed).toBe(false);
      expect(updatedA.turnResources.movementRemaining).toBe(30);
    });
  });

  // ═══════════════════════════════════════════════════
  // DELAY TURN
  // ═══════════════════════════════════════════════════

  describe('delayTurn', () => {
    test('moves combatant to new initiative position', () => {
      const enc = makeEncounter([
        makeCombatant('a', 20),
        makeCombatant('b', 15),
        makeCombatant('c', 10),
      ], 0);
      // a delays to initiative 12 (between b and c)
      const delayed = delayTurn(enc, 'a', 12);
      expect(delayed.initiativeOrder[0].id).toBe('b');
      expect(delayed.initiativeOrder[1].id).toBe('a');
      expect(delayed.initiativeOrder[2].id).toBe('c');
    });

    test('returns unchanged encounter if combatant not found', () => {
      const enc = makeEncounter([makeCombatant('a', 20)], 0);
      const result = delayTurn(enc, 'nonexistent', 5);
      expect(result.initiativeOrder.length).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════
  // FORMAT
  // ═══════════════════════════════════════════════════

  describe('formatInitiativeOrder', () => {
    test('includes round number and all combatants', () => {
      const enc = makeEncounter([
        makeCombatant('a', 20),
        makeCombatant('b', 15),
      ], 0);
      const text = formatInitiativeOrder(enc);
      expect(text).toContain('Round 1');
      expect(text).toContain('Combatant a');
      expect(text).toContain('Combatant b');
    });

    test('marks current turn combatant', () => {
      const enc = makeEncounter([
        makeCombatant('a', 20),
        makeCombatant('b', 15),
      ], 0);
      const text = formatInitiativeOrder(enc);
      expect(text).toContain('▶️');
    });
  });
});
