import { describe, expect, it } from "bun:test";
import {
  secureShuffle,
  securePickN,
  shouldFireEvent,
  weightedPick,
} from "../../engine/src/utils/entropy";

/**
 * Secure randomization for game fairness. The properties tested hold for EVERY
 * RNG outcome (so they can't flake): a shuffle is a permutation, picks stay in
 * bounds, an all-weight item always wins, and the cooldown gate hard-blocks
 * before minCooldown / at zero probability and always fires at probability 1.
 */

describe("secureShuffle / securePickN", () => {
  it("shuffle is a permutation; picks respect count bounds", () => {
    const src = [1, 2, 3, 4, 5];
    const shuffled = secureShuffle(src);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(src);
    expect(securePickN(src, 0)).toEqual([]);
    expect(securePickN(src, 99)).toHaveLength(5);
    const two = securePickN(src, 2);
    expect(two).toHaveLength(2);
    expect(new Set(two).size).toBe(2); // unique
    expect(two.every((x) => src.includes(x))).toBe(true);
  });
});

describe("weightedPick", () => {
  it("throws on empty, returns the sole/all-weight item deterministically", () => {
    expect(() => weightedPick([], () => 1)).toThrow();
    expect(weightedPick(["x"], () => 1)).toBe("x");
    // 'a' holds all the weight → must always be chosen.
    for (let i = 0; i < 50; i++) {
      expect(weightedPick(["a", "b", "c"], (it) => (it === "a" ? 1 : 0))).toBe(
        "a",
      );
    }
  });
});

describe("shouldFireEvent", () => {
  const state = (over: Record<string, number>) => ({
    lastOccurrence: 0,
    minCooldown: 0,
    baseProbability: 0,
    maxProbability: 0,
    decayRate: 0,
    ...over,
  });

  it("blocks before minCooldown and at zero probability, always fires at p=1", () => {
    expect(shouldFireEvent(state({ minCooldown: 100 }) as never, 50)).toBe(false);
    expect(shouldFireEvent(state({}) as never, 1000)).toBe(false); // p=0
    for (let i = 0; i < 20; i++) {
      expect(
        shouldFireEvent(
          state({ baseProbability: 1, maxProbability: 1 }) as never,
          1000,
        ),
      ).toBe(true);
    }
  });
});
