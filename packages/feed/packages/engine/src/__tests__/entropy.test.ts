/**
 * Entropy Utilities Test Suite
 *
 * Tests for secure randomization, weighted selection, cooldowns, and sentiment signals.
 */

import { describe, expect, test } from "bun:test";
import {
  biasedRandomCount,
  type EventCooldownState,
  generateSentimentSignal,
  SeededRandom,
  securePickN,
  secureRandom,
  secureRandomInt,
  secureShuffle,
  shouldFireEvent,
  urgencyWeight,
  weightedPick,
} from "../utils/entropy";

describe("Entropy - Core Random", () => {
  test("secureRandom returns values in [0, 1)", () => {
    for (let i = 0; i < 100; i++) {
      const val = secureRandom();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
    }
  });

  test("secureRandomInt returns values in [min, max]", () => {
    for (let i = 0; i < 100; i++) {
      const val = secureRandomInt(5, 10);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThanOrEqual(10);
      expect(Number.isInteger(val)).toBe(true);
    }
  });

  test("secureShuffle returns array of same length", () => {
    const arr = [1, 2, 3, 4, 5];
    const shuffled = secureShuffle(arr);
    expect(shuffled.length).toBe(arr.length);
    expect(shuffled.sort()).toEqual(arr.sort());
  });

  test("secureShuffle does not mutate original", () => {
    const arr = [1, 2, 3, 4, 5];
    const original = [...arr];
    secureShuffle(arr);
    expect(arr).toEqual(original);
  });

  test("securePickN returns correct count", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const picked = securePickN(arr, 3);
    expect(picked.length).toBe(3);
    // All picked items should be from original
    picked.forEach((item) => expect(arr).toContain(item));
  });

  test("securePickN with count > length returns all items shuffled", () => {
    const arr = [1, 2, 3];
    const picked = securePickN(arr, 10);
    expect(picked.length).toBe(3);
    expect(picked.sort()).toEqual(arr.sort());
  });

  test("biasedRandomCount returns values in range", () => {
    for (let i = 0; i < 100; i++) {
      const val = biasedRandomCount(5, 15);
      expect(val).toBeGreaterThanOrEqual(5);
      expect(val).toBeLessThanOrEqual(15);
      expect(Number.isInteger(val)).toBe(true);
    }
  });
});

describe("Entropy - Weighted Selection", () => {
  test("weightedPick throws on empty array", () => {
    expect(() => weightedPick([], () => 1)).toThrow("Empty array");
  });

  test("weightedPick returns only item for single-element array", () => {
    const result = weightedPick([42], () => 1);
    expect(result).toBe(42);
  });

  test("weightedPick respects weights", () => {
    const items = [
      { id: "heavy", weight: 100 },
      { id: "light", weight: 1 },
    ];

    const counts: Record<string, number> = { heavy: 0, light: 0 };
    for (let i = 0; i < 1000; i++) {
      const picked = weightedPick(items, (item) => item.weight);
      counts[picked.id]++;
    }

    // Heavy should be picked much more often
    expect(counts.heavy).toBeGreaterThan(counts.light * 10);
  });

  test("weightedPick handles zero/negative weights gracefully", () => {
    const items = [1, 2, 3];
    // Should not throw, falls back to uniform
    const result = weightedPick(items, () => 0);
    expect(items).toContain(result);
  });

  test("urgencyWeight returns higher weight for closer resolution", () => {
    const soon = { resolutionDate: new Date(Date.now() + 30 * 60 * 1000) }; // 30 min
    const later = {
      resolutionDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }; // 7 days

    const weightFn = urgencyWeight(5);
    expect(weightFn(soon)).toBeGreaterThan(weightFn(later));
  });

  test("urgencyWeight handles null resolutionDate", () => {
    const noDate = { resolutionDate: null };
    const weightFn = urgencyWeight(5);
    expect(weightFn(noDate)).toBe(1); // Base weight only
  });
});

describe("Entropy - Event Cooldowns", () => {
  test("shouldFireEvent respects minCooldown", () => {
    const state: EventCooldownState = {
      lastOccurrence: 100,
      minCooldown: 10,
      baseProbability: 1.0, // Always fire after cooldown
      decayRate: 0,
      maxProbability: 1.0,
    };

    // Too soon
    expect(shouldFireEvent(state, 105)).toBe(false);
    expect(state.lastOccurrence).toBe(100); // Unchanged

    // After cooldown (with 100% probability)
    expect(shouldFireEvent(state, 115)).toBe(true);
    expect(state.lastOccurrence).toBe(115); // Updated
  });

  test("shouldFireEvent probability increases with decay", () => {
    let fires = 0;
    for (let i = 0; i < 100; i++) {
      const state: EventCooldownState = {
        lastOccurrence: 0,
        minCooldown: 5,
        baseProbability: 0.1,
        decayRate: 0.1,
        maxProbability: 1.0,
      };
      // At time 100, decay = (100-5) * 0.1 = 9.5, so prob = min(1.0, 0.1 + 9.5) = 1.0
      if (shouldFireEvent(state, 100)) fires++;
    }
    // Should fire every time due to max probability reached
    expect(fires).toBe(100);
  });

  test("shouldFireEvent respects maxProbability", () => {
    const state: EventCooldownState = {
      lastOccurrence: 0,
      minCooldown: 1,
      baseProbability: 0.5,
      decayRate: 1.0, // Very high decay
      maxProbability: 0.5, // Capped at 50%
    };

    let fires = 0;
    for (let i = 0; i < 1000; i++) {
      const testState = { ...state };
      if (shouldFireEvent(testState, 100)) fires++;
    }

    // Should be around 50% (±10% tolerance)
    expect(fires).toBeGreaterThan(400);
    expect(fires).toBeLessThan(600);
  });
});

describe("Entropy - Sentiment Signals", () => {
  test("generateSentimentSignal returns values in [-1, 1]", () => {
    for (let i = 0; i < 100; i++) {
      const val = generateSentimentSignal(true, 0.8, 0.5);
      expect(val).toBeGreaterThanOrEqual(-1);
      expect(val).toBeLessThanOrEqual(1);
    }
  });

  test("positive signal trends positive", () => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += generateSentimentSignal(true, 0.7, 0.2);
    }
    expect(sum / 100).toBeGreaterThan(0.3); // Average should be positive
  });

  test("negative signal trends negative", () => {
    let sum = 0;
    for (let i = 0; i < 100; i++) {
      sum += generateSentimentSignal(false, 0.7, 0.2);
    }
    expect(sum / 100).toBeLessThan(-0.3); // Average should be negative
  });

  test("noise adds variance", () => {
    const signals: number[] = [];
    for (let i = 0; i < 100; i++) {
      signals.push(generateSentimentSignal(true, 0.5, 0.3));
    }
    const min = Math.min(...signals);
    const max = Math.max(...signals);
    expect(max - min).toBeGreaterThan(0.2); // Should have some spread
  });
});

describe("Entropy - SeededRandom", () => {
  test("same seed produces same sequence", () => {
    const rng1 = new SeededRandom(12345);
    const rng2 = new SeededRandom(12345);

    for (let i = 0; i < 10; i++) {
      expect(rng1.next()).toBe(rng2.next());
    }
  });

  test("different seeds produce different sequences", () => {
    const rng1 = new SeededRandom(12345);
    const rng2 = new SeededRandom(54321);

    let same = 0;
    for (let i = 0; i < 10; i++) {
      if (rng1.next() === rng2.next()) same++;
    }
    expect(same).toBeLessThan(3); // Very unlikely to match
  });

  test("string seed works", () => {
    const rng1 = new SeededRandom("test-seed");
    const rng2 = new SeededRandom("test-seed");

    expect(rng1.next()).toBe(rng2.next());
  });

  test("nextInt returns integers in range", () => {
    const rng = new SeededRandom(42);
    for (let i = 0; i < 100; i++) {
      const val = rng.nextInt(10, 20);
      expect(val).toBeGreaterThanOrEqual(10);
      expect(val).toBeLessThanOrEqual(20);
      expect(Number.isInteger(val)).toBe(true);
    }
  });

  test("nextFloat returns floats in range", () => {
    const rng = new SeededRandom(42);
    for (let i = 0; i < 100; i++) {
      const val = rng.nextFloat(1.5, 3.5);
      expect(val).toBeGreaterThanOrEqual(1.5);
      expect(val).toBeLessThanOrEqual(3.5);
    }
  });

  test("pick returns item from array", () => {
    const rng = new SeededRandom(42);
    const arr = ["a", "b", "c", "d"];
    for (let i = 0; i < 20; i++) {
      expect(arr).toContain(rng.pick(arr));
    }
  });

  test("shuffle returns all items", () => {
    const rng = new SeededRandom(42);
    const arr = [1, 2, 3, 4, 5];
    const shuffled = rng.shuffle(arr);
    expect(shuffled.length).toBe(arr.length);
    expect(shuffled.sort()).toEqual(arr.sort());
  });

  test("shuffle is deterministic with same seed", () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const rng1 = new SeededRandom(999);
    const rng2 = new SeededRandom(999);

    expect(rng1.shuffle(arr)).toEqual(rng2.shuffle(arr));
  });
});
