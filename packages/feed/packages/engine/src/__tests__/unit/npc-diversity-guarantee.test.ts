/**
 * NPC Diversity Guarantee Test Suite
 *
 * Tests for the diversity guarantee mechanism that ensures
 * broader NPC posting coverage across all NPCs.
 *
 * FIRST Principles:
 * - Fast: Unit tests with no I/O
 * - Isolated: No external dependencies
 * - Repeatable: Deterministic with mock random
 * - Self-validating: Clear assertions
 * - Timely: Written alongside the feature
 */

import { describe, expect, test } from 'bun:test';
import type { ActorStateRow } from '@feed/db';
import { StaticDataRegistry } from '../../services/static-data-registry';
import { toDateString } from '../../utils/date-utils';

/**
 * Mock actor state for testing diversity selection
 */
const createMockActorState = (
  id: string,
  lastPostAt: Date | null
): Partial<ActorStateRow> => ({
  id,
  lastPostAt,
  postsToday: lastPostAt ? 1 : 0,
});

describe('NPC Diversity Guarantee - Selection Logic', () => {
  test('filters NPCs that have not posted today correctly', () => {
    const today = new Date('2026-01-05T14:00:00Z');
    const todayStr = toDateString(today);

    // Simulate state map with some NPCs having posted today, some not
    const stateMap = new Map<string, Partial<ActorStateRow>>([
      [
        'npc-1',
        createMockActorState('npc-1', new Date('2026-01-05T10:00:00Z')),
      ], // Posted today
      [
        'npc-2',
        createMockActorState('npc-2', new Date('2026-01-04T10:00:00Z')),
      ], // Posted yesterday
      ['npc-3', createMockActorState('npc-3', null)], // Never posted
      [
        'npc-4',
        createMockActorState('npc-4', new Date('2026-01-05T08:00:00Z')),
      ], // Posted today
    ]);

    const activeNpcs = [
      { id: 'npc-1', name: 'NPC 1' },
      { id: 'npc-2', name: 'NPC 2' },
      { id: 'npc-3', name: 'NPC 3' },
      { id: 'npc-4', name: 'NPC 4' },
    ];

    // Filter NPCs that haven't posted today (same logic as npc-tick route)
    const neverPostedToday = activeNpcs.filter((npc) => {
      const state = stateMap.get(npc.id);
      const lastPost = state?.lastPostAt;
      return !lastPost || toDateString(lastPost) !== todayStr;
    });

    // NPC 2 (posted yesterday) and NPC 3 (never posted) should be in diversity pool
    expect(neverPostedToday.length).toBe(2);
    expect(neverPostedToday.map((n) => n.id).sort()).toEqual([
      'npc-2',
      'npc-3',
    ]);
  });

  test('diversity slots calculation is at least 1', () => {
    const batchSizes = [1, 2, 3, 5, 10, 12, 20];
    const diversityRatio = 0.3;

    for (const batchSize of batchSizes) {
      const diversitySlots = Math.max(
        1,
        Math.floor(batchSize * diversityRatio)
      );
      expect(diversitySlots).toBeGreaterThanOrEqual(1);
    }
  });

  test('diversity slots calculation for batch size 12 is 3-4', () => {
    const batchSize = 12;
    const diversityRatio = 0.3;
    const diversitySlots = Math.max(1, Math.floor(batchSize * diversityRatio));

    // 12 * 0.3 = 3.6, floor = 3
    expect(diversitySlots).toBe(3);
  });

  test('regular slots is batch size minus diversity slots', () => {
    const batchSize = 12;
    const diversityRatio = 0.3;
    const diversitySlots = Math.max(1, Math.floor(batchSize * diversityRatio));
    const regularSlots = batchSize - diversitySlots;

    expect(regularSlots).toBe(9);
    expect(diversitySlots + regularSlots).toBe(batchSize);
  });
});

describe('NPC Diversity Guarantee - Edge Cases', () => {
  test('handles case when all NPCs have posted today', () => {
    const today = new Date('2026-01-05T14:00:00Z');
    const todayStr = toDateString(today);

    const stateMap = new Map<string, Partial<ActorStateRow>>([
      [
        'npc-1',
        createMockActorState('npc-1', new Date('2026-01-05T10:00:00Z')),
      ],
      [
        'npc-2',
        createMockActorState('npc-2', new Date('2026-01-05T11:00:00Z')),
      ],
    ]);

    const activeNpcs = [
      { id: 'npc-1', name: 'NPC 1' },
      { id: 'npc-2', name: 'NPC 2' },
    ];

    const neverPostedToday = activeNpcs.filter((npc) => {
      const state = stateMap.get(npc.id);
      const lastPost = state?.lastPostAt;
      return !lastPost || toDateString(lastPost) !== todayStr;
    });

    // All NPCs posted today, diversity pool is empty
    expect(neverPostedToday.length).toBe(0);
  });

  test('handles case when no NPCs have state', () => {
    const today = new Date('2026-01-05T14:00:00Z');
    const todayStr = toDateString(today);

    const stateMap = new Map<string, Partial<ActorStateRow>>();

    const activeNpcs = [
      { id: 'npc-1', name: 'NPC 1' },
      { id: 'npc-2', name: 'NPC 2' },
    ];

    const neverPostedToday = activeNpcs.filter((npc) => {
      const state = stateMap.get(npc.id);
      const lastPost = state?.lastPostAt;
      return !lastPost || toDateString(lastPost) !== todayStr;
    });

    // No state means all NPCs are in diversity pool
    expect(neverPostedToday.length).toBe(2);
  });

  test('handles midnight boundary correctly', () => {
    // Test that posts at 23:59:59 yesterday vs 00:00:01 today are handled correctly
    const today = new Date('2026-01-05T00:30:00Z');
    const todayStr = toDateString(today); // '2026-01-05'

    const stateMap = new Map<string, Partial<ActorStateRow>>([
      // Posted at 23:59 yesterday (should be in diversity pool)
      [
        'npc-1',
        createMockActorState('npc-1', new Date('2026-01-04T23:59:00Z')),
      ],
      // Posted at 00:01 today (should NOT be in diversity pool)
      [
        'npc-2',
        createMockActorState('npc-2', new Date('2026-01-05T00:01:00Z')),
      ],
    ]);

    const activeNpcs = [
      { id: 'npc-1', name: 'NPC 1' },
      { id: 'npc-2', name: 'NPC 2' },
    ];

    const neverPostedToday = activeNpcs.filter((npc) => {
      const state = stateMap.get(npc.id);
      const lastPost = state?.lastPostAt;
      return !lastPost || toDateString(lastPost) !== todayStr;
    });

    // Only NPC 1 (posted yesterday) should be in diversity pool
    expect(neverPostedToday.length).toBe(1);
    expect(neverPostedToday[0]?.id).toBe('npc-1');
  });
});

describe('Actor Data Completeness - FIRST Principles', () => {
  test('all actors should have id', () => {
    const actors = StaticDataRegistry.getAllActors();
    const missing = actors.filter((a) => !a.id);
    expect(missing.length).toBe(0);
  });

  test('all actors should have name', () => {
    const actors = StaticDataRegistry.getAllActors();
    const missing = actors.filter((a) => !a.name);
    expect(missing.length).toBe(0);
  });

  test('all actors should have postStyle for generating posts', () => {
    const actors = StaticDataRegistry.getAllActors();
    const missing = actors.filter((a) => !a.postStyle);

    // Log missing actors for debugging if any
    if (missing.length > 0 && process.env.DEBUG_TESTS) {
      console.debug(
        'Actors missing postStyle:',
        missing.map((a) => a.id)
      );
    }

    expect(missing.length).toBe(0);
  });

  test('all production actors should have postExample array with at least one example', () => {
    const actors = StaticDataRegistry.getAllActors();
    // Exclude test actors (they're filtered out in npc-tick anyway)
    const productionActors = actors.filter((a) => !a.isTest);
    const missing = productionActors.filter(
      (a) => !Array.isArray(a.postExample) || a.postExample.length === 0
    );

    if (missing.length > 0 && process.env.DEBUG_TESTS) {
      console.debug(
        'Actors missing postExample:',
        missing.map((a) => a.id)
      );
    }

    expect(missing.length).toBe(0);
  });

  test('all actors should have domain array', () => {
    const actors = StaticDataRegistry.getAllActors();
    const missing = actors.filter((a) => !Array.isArray(a.domain));
    expect(missing.length).toBe(0);
  });

  test('actor count should be at least 100 for diverse feed', () => {
    const actors = StaticDataRegistry.getAllActors();
    // Filter out test actors
    const productionActors = actors.filter((a) => !a.isTest);
    expect(productionActors.length).toBeGreaterThanOrEqual(100);
  });
});
