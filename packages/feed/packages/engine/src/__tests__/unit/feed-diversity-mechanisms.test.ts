/**
 * Feed Diversity Mechanisms Test Suite
 *
 * Tests for TikTok-inspired feed diversity functions:
 * - shuffleWithNoConsecutive: Shuffles with no consecutive same values
 * - createDiscourseActionDeck: Creates stratified action deck
 * - ActionDiversityTracker: Tracks and prevents consecutive action clustering
 *
 * FIRST Principles:
 * - Fast: Unit tests with no I/O
 * - Isolated: No external dependencies
 * - Repeatable: Deterministic with seeded random
 * - Self-validating: Clear assertions
 * - Timely: Written alongside the feature
 */

import { describe, expect, test } from 'bun:test';
import {
  ActionDiversityTracker,
  createDiscourseActionDeck,
  shuffleWithNoConsecutive,
} from '../../utils/feed-diversity';

// =============================================================================
// TESTS: shuffleWithNoConsecutive
// =============================================================================

describe('shuffleWithNoConsecutive', () => {
  // Deterministic random for testing (Mulberry32 PRNG)
  const createSeededRandom = (seed: number) => {
    let t = seed + 0x6d2b79f5;
    return () => {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  test('returns empty array for empty input', () => {
    const result = shuffleWithNoConsecutive([], Math.random);
    expect(result).toEqual([]);
  });

  test('returns single element for single element input', () => {
    const result = shuffleWithNoConsecutive(['a'], Math.random);
    expect(result).toEqual(['a']);
  });

  test('preserves all elements', () => {
    const random = createSeededRandom(42);
    const input = ['a', 'b', 'c', 'a', 'b', 'c'];
    const result = shuffleWithNoConsecutive(input, random);

    expect(result.length).toBe(input.length);
    expect(result.sort()).toEqual(input.sort());
  });

  test('no consecutive same values when possible', () => {
    // Run multiple times with different seeds to verify constraint holds
    // when the input allows for a valid arrangement
    for (const seed of [1, 2, 3, 4, 5, 100, 200, 300]) {
      const random = createSeededRandom(seed);
      const input = ['a', 'a', 'b', 'b', 'c', 'c'];
      const result = shuffleWithNoConsecutive(input, random);

      // With equal distribution (2 of each), constraint should always be satisfiable
      for (let i = 1; i < result.length; i++) {
        expect(result[i]).not.toBe(result[i - 1]);
      }
    }
  });

  test('handles impossible case gracefully (all same values)', () => {
    const random = createSeededRandom(42);
    const input = ['a', 'a', 'a', 'a'];
    const result = shuffleWithNoConsecutive(input, random);

    // Should return all elements even when constraint can't be satisfied
    expect(result.length).toBe(4);
    expect(result.every((x) => x === 'a')).toBe(true);
  });

  test('handles edge case with majority of one type', () => {
    const random = createSeededRandom(42);
    // 4 'a' and 2 'b' - impossible to fully satisfy constraint
    const input = ['a', 'a', 'a', 'a', 'b', 'b'];
    const result = shuffleWithNoConsecutive(input, random);

    // Should preserve all elements
    expect(result.length).toBe(6);
    expect(result.filter((x) => x === 'a').length).toBe(4);
    expect(result.filter((x) => x === 'b').length).toBe(2);
  });

  test('deterministic with same seed', () => {
    const input = ['quote', 'quote', 'reply', 'reply', 'reply'];

    const result1 = shuffleWithNoConsecutive(input, createSeededRandom(123));
    const result2 = shuffleWithNoConsecutive(input, createSeededRandom(123));

    expect(result1).toEqual(result2);
  });

  // Dead-end prevention tests
  test('prevents dead-ends with 3a-2b distribution (solvable)', () => {
    // 3 'a' and 2 'b' - this IS solvable: a-b-a-b-a
    // The safety check should prevent picking both 'b' values early
    for (const seed of [1, 2, 3, 4, 5, 10, 20, 50, 100]) {
      const random = createSeededRandom(seed);
      const input = ['a', 'a', 'a', 'b', 'b'];
      const result = shuffleWithNoConsecutive(input, random);

      // Should have no consecutive same values
      for (let i = 1; i < result.length; i++) {
        expect(result[i]).not.toBe(result[i - 1]);
      }
    }
  });

  test('handles 4a-1b distribution (impossible) gracefully', () => {
    // 4 'a' and 1 'b' - impossible to fully satisfy (max 3 non-consecutive)
    const random = createSeededRandom(42);
    const input = ['a', 'a', 'a', 'a', 'b'];
    const result = shuffleWithNoConsecutive(input, random);

    // Should preserve all elements
    expect(result.length).toBe(5);
    expect(result.filter((x) => x === 'a').length).toBe(4);
    expect(result.filter((x) => x === 'b').length).toBe(1);

    // Should still include the 'b'
    expect(result).toContain('b');
  });

  test('handles 5a-2b distribution (not solvable)', () => {
    // 5 'a' and 2 'b' - NOT solvable: max interleaving is a-b-a-b-a-a-a
    // 5 + 2 = 7, ceil(7/2) = 4, and max count is 5 > 4, so NOT solvable
    // Best case still has consecutive 'a's at the end
    const random = createSeededRandom(42);
    const input = ['a', 'a', 'a', 'a', 'a', 'b', 'b'];
    const result = shuffleWithNoConsecutive(input, random);

    // Should preserve all elements
    expect(result.length).toBe(7);
    expect(result.filter((x) => x === 'a').length).toBe(5);
    expect(result.filter((x) => x === 'b').length).toBe(2);
  });

  test('handles 4a-3b distribution (solvable)', () => {
    // 4 'a' and 3 'b' - this IS solvable: a-b-a-b-a-b-a
    // 7 items, ceil(7/2) = 4, max count is 4 = 4, so solvable
    for (const seed of [1, 5, 10, 42, 100]) {
      const random = createSeededRandom(seed);
      const input = ['a', 'a', 'a', 'a', 'b', 'b', 'b'];
      const result = shuffleWithNoConsecutive(input, random);

      // Should have no consecutive same values
      for (let i = 1; i < result.length; i++) {
        expect(result[i]).not.toBe(result[i - 1]);
      }
    }
  });
});

// =============================================================================
// TESTS: createDiscourseActionDeck
// =============================================================================

describe('createDiscourseActionDeck', () => {
  // Deterministic random for testing (Mulberry32 PRNG)
  const createSeededRandom = (seed: number) => {
    let t = seed + 0x6d2b79f5;
    return () => {
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  test('returns empty array for zero slots', () => {
    const result = createDiscourseActionDeck(0, 0.3, Math.random);
    expect(result).toEqual([]);
  });

  test('returns empty array for negative slots', () => {
    const result = createDiscourseActionDeck(-5, 0.3, Math.random);
    expect(result).toEqual([]);
  });

  test('creates correct ratio of quotes to replies', () => {
    const random = createSeededRandom(42);
    const result = createDiscourseActionDeck(10, 0.3, random);

    const quotes = result.filter((a) => a === 'quote').length;
    const replies = result.filter((a) => a === 'reply').length;

    // 10 * 0.3 = 3 quotes, 7 replies
    expect(quotes).toBe(3);
    expect(replies).toBe(7);
    expect(result.length).toBe(10);
  });

  test('clamps ratio to 0 for negative values', () => {
    const random = createSeededRandom(42);
    const result = createDiscourseActionDeck(10, -0.5, random);

    const quotes = result.filter((a) => a === 'quote').length;
    expect(quotes).toBe(0);
    expect(result.length).toBe(10);
  });

  test('clamps ratio to 1 for values > 1', () => {
    const random = createSeededRandom(42);
    const result = createDiscourseActionDeck(10, 1.5, random);

    const quotes = result.filter((a) => a === 'quote').length;
    expect(quotes).toBe(10);
    expect(result.length).toBe(10);
  });

  test('maintains no-consecutive constraint when possible', () => {
    const random = createSeededRandom(42);
    // 50% ratio should easily satisfy constraint
    const result = createDiscourseActionDeck(10, 0.5, random);

    for (let i = 1; i < result.length; i++) {
      expect(result[i]).not.toBe(result[i - 1]);
    }
  });

  test('handles 0% quote ratio', () => {
    const random = createSeededRandom(42);
    const result = createDiscourseActionDeck(5, 0, random);

    expect(result.every((a) => a === 'reply')).toBe(true);
    expect(result.length).toBe(5);
  });

  test('handles 100% quote ratio', () => {
    const random = createSeededRandom(42);
    const result = createDiscourseActionDeck(5, 1, random);

    expect(result.every((a) => a === 'quote')).toBe(true);
    expect(result.length).toBe(5);
  });
});

// =============================================================================
// TESTS: ActionDiversityTracker
// =============================================================================

describe('ActionDiversityTracker', () => {
  test('initial state allows any action', () => {
    const tracker = new ActionDiversityTracker(5, 2);

    expect(tracker.shouldSkipForDiversity('like')).toBe(false);
    expect(tracker.shouldSkipForDiversity('share')).toBe(false);
    expect(tracker.shouldSkipForDiversity('comment')).toBe(false);
  });

  test('allows action after recording one of the same type', () => {
    const tracker = new ActionDiversityTracker(5, 2);

    tracker.recordAction('like');
    // Only 1 consecutive like, maxConsecutive is 2, so still allowed
    expect(tracker.shouldSkipForDiversity('like')).toBe(false);
  });

  test('skips action after maxConsecutive of same type', () => {
    const tracker = new ActionDiversityTracker(5, 2);

    tracker.recordAction('like');
    tracker.recordAction('like');
    // Now 2 consecutive likes, should skip
    expect(tracker.shouldSkipForDiversity('like')).toBe(true);
  });

  test('allows action after different action breaks streak', () => {
    const tracker = new ActionDiversityTracker(5, 2);

    tracker.recordAction('like');
    tracker.recordAction('like');
    tracker.recordAction('share'); // Breaks the streak
    // Now last 2 are [like, share], like is allowed again
    expect(tracker.shouldSkipForDiversity('like')).toBe(false);
  });

  test('tracks distribution correctly', () => {
    const tracker = new ActionDiversityTracker(10, 2);

    tracker.recordAction('like');
    tracker.recordAction('share');
    tracker.recordAction('comment');
    tracker.recordAction('like');
    tracker.recordAction('share');

    const dist = tracker.getDistribution();
    expect(dist.like).toBe(2);
    expect(dist.share).toBe(2);
    expect(dist.comment).toBe(1);
  });

  test('buffer size respects maxRecent limit', () => {
    const tracker = new ActionDiversityTracker(3, 2);

    tracker.recordAction('like');
    tracker.recordAction('share');
    tracker.recordAction('comment');
    tracker.recordAction('like'); // Oldest (first like) should be dropped

    const dist = tracker.getDistribution();
    expect(dist.like).toBe(1);
    expect(dist.share).toBe(1);
    expect(dist.comment).toBe(1);
  });

  test('buffer size is at least maxConsecutive', () => {
    // maxRecent (2) < maxConsecutive (5), should adjust
    const tracker = new ActionDiversityTracker(2, 5);

    // Record 5 likes
    for (let i = 0; i < 5; i++) {
      tracker.recordAction('like');
    }

    // Should track all 5 and detect consecutive
    expect(tracker.shouldSkipForDiversity('like')).toBe(true);
  });

  test('maxConsecutive of 1 means never allow consecutive', () => {
    const tracker = new ActionDiversityTracker(5, 1);

    tracker.recordAction('like');
    expect(tracker.shouldSkipForDiversity('like')).toBe(true);
    expect(tracker.shouldSkipForDiversity('share')).toBe(false);
  });
});
