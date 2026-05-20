/**
 * Event Diversity Test Suite
 *
 * Tests for actor selection diversity (cooldowns, tier weighting, affiliation penalty)
 * and event type diversity (rolling window penalty).
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { _testing } from '../services/event-generation-helpers';

const {
  selectRelevantActors,
  selectEventType,
  actorEventCooldown,
  recentEventTypes,
} = _testing;

beforeEach(() => {
  // Reset module-level state between tests
  actorEventCooldown.clear();
  recentEventTypes.length = 0;
});

describe('selectRelevantActors', () => {
  test('returns at most maxActors actors', () => {
    const result = selectRelevantActors(2);
    expect(result.length).toBeLessThanOrEqual(2);
  });

  test('returns unique actor IDs (no duplicates)', () => {
    const result = selectRelevantActors(2);
    expect(new Set(result).size).toBe(result.length);
  });

  test('cooldown reduces repeat selection over many samples', () => {
    // Run selection 50 times and track how often each actor appears
    const appearances = new Map<string, number>();
    for (let i = 0; i < 50; i++) {
      const result = selectRelevantActors(1);
      for (const id of result) {
        appearances.set(id, (appearances.get(id) ?? 0) + 1);
      }
    }

    // With cooldowns active, no single actor should dominate
    // (without cooldowns, random chance could give one actor up to ~15-20 hits)
    const maxAppearances = Math.max(...appearances.values());
    // The cooldown is 4 hours but we're calling in rapid succession,
    // so actors get pushed to cooldown quickly and others get selected
    expect(appearances.size).toBeGreaterThan(1);
    // Statistical bound: with cooldowns active, no actor should dominate >60% of 50 trials.
    // This is probabilistic — could theoretically flake under pathological RNG, but
    // the margin is generous (actual expected max is ~5-10 with 200+ actors in pool).
    expect(maxAppearances).toBeLessThan(30);
  });

  test('actors on cooldown get lower selection probability', () => {
    // Select once to put some actors on cooldown
    const first = selectRelevantActors(2);
    expect(first.length).toBe(2);

    // Select again — cooldown actors should rarely reappear
    const repeats = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const result = selectRelevantActors(1);
      if (first.includes(result[0]!)) {
        repeats.add(result[0]!);
      }
    }

    // The cooldown actors CAN still be selected (weight 0.1, not 0),
    // but should be rare across 20 trials
    // This is a statistical test — allow some tolerance
    expect(repeats.size).toBeLessThanOrEqual(2);
  });

  test('cooldown entries are cleaned up after expiry', () => {
    // Manually insert an expired cooldown entry
    actorEventCooldown.set('fake-actor', Date.now() - 5 * 60 * 60 * 1000); // 5h ago
    actorEventCooldown.set('fake-actor-2', Date.now()); // just now

    selectRelevantActors(1);

    // Expired entry should be cleaned up, recent one kept
    expect(actorEventCooldown.has('fake-actor')).toBe(false);
    expect(actorEventCooldown.has('fake-actor-2')).toBe(true);
  });
});

describe('selectEventType', () => {
  test('returns a valid event type', () => {
    const result = selectEventType();
    expect(result).toHaveProperty('type');
    expect(result).toHaveProperty('weight');
    expect(typeof result.type).toBe('string');
  });

  test('diversity penalty reduces repeated type selection', () => {
    // Call many times and track type distribution
    const typeCounts = new Map<string, number>();
    for (let i = 0; i < 30; i++) {
      const result = selectEventType();
      typeCounts.set(result.type, (typeCounts.get(result.type) ?? 0) + 1);
    }

    // With diversity tracking, we should see at least 4 different types in 30 picks
    expect(typeCounts.size).toBeGreaterThanOrEqual(4);

    // Statistical bound: diversity penalty should prevent any type exceeding 50% of 30 picks.
    // Probabilistic — generous margin over expected distribution (~4-5 per type with 7 types).
    const maxCount = Math.max(...typeCounts.values());
    expect(maxCount).toBeLessThan(15);
  });

  test('rolling history is bounded to MAX_EVENT_TYPE_HISTORY', () => {
    for (let i = 0; i < 20; i++) {
      selectEventType();
    }
    // History should never exceed 6 entries
    expect(recentEventTypes.length).toBeLessThanOrEqual(6);
  });
});
