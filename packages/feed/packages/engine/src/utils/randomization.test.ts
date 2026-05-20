/**
 * Tests for randomization utilities with seeded RNG support
 */
import { describe, expect, it } from 'bun:test';
import { SeededRandom } from './entropy';
import {
  pickRandom,
  randomChance,
  randomInt,
  sampleRandom,
  shuffleArray,
} from './randomization';

describe('randomization with seeded RNG', () => {
  describe('shuffleArray', () => {
    it('produces deterministic results with seeded RNG', () => {
      const rng1 = new SeededRandom(42);
      const rng2 = new SeededRandom(42);
      const array = [1, 2, 3, 4, 5];

      const result1 = shuffleArray(array, () => rng1.next());
      const result2 = shuffleArray(array, () => rng2.next());

      expect(result1).toEqual(result2);
    });

    it('produces expected permutation for known seed', () => {
      // Use a fixed seed and verify against a known output
      // This is deterministic and will never flake
      const rng = new SeededRandom(12345);
      const array = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      const result = shuffleArray(array, () => rng.next());

      // Pre-computed expected result for seed 12345 with array [1..10]
      // If SeededRandom implementation changes, this test will catch it
      expect(result).toEqual([10, 2, 4, 7, 5, 1, 9, 6, 3, 8]);
    });

    it('does not mutate the original array', () => {
      const rng = new SeededRandom(42);
      const original = [1, 2, 3, 4, 5];
      const originalCopy = [...original];

      shuffleArray(original, () => rng.next());

      expect(original).toEqual(originalCopy);
    });

    it('returns empty array for empty input', () => {
      const rng = new SeededRandom(42);
      const result = shuffleArray([], () => rng.next());
      expect(result).toEqual([]);
    });
  });

  describe('pickRandom', () => {
    it('produces deterministic results with seeded RNG', () => {
      const rng1 = new SeededRandom(42);
      const rng2 = new SeededRandom(42);
      const array = ['a', 'b', 'c', 'd', 'e'];

      const result1 = pickRandom(array, () => rng1.next());
      const result2 = pickRandom(array, () => rng2.next());

      expect(result1).toBe(result2);
    });

    it('returns undefined for empty array', () => {
      const rng = new SeededRandom(42);
      const result = pickRandom([], () => rng.next());
      expect(result).toBeUndefined();
    });

    it('returns the only element for single-element array', () => {
      const rng = new SeededRandom(42);
      const result = pickRandom(['only'], () => rng.next());
      expect(result).toBe('only');
    });
  });

  describe('randomChance', () => {
    it('produces deterministic results with seeded RNG', () => {
      const rng1 = new SeededRandom(42);
      const rng2 = new SeededRandom(42);

      const results1: boolean[] = [];
      const results2: boolean[] = [];

      for (let i = 0; i < 10; i++) {
        results1.push(randomChance(0.5, () => rng1.next()));
        results2.push(randomChance(0.5, () => rng2.next()));
      }

      expect(results1).toEqual(results2);
    });

    it('always returns true for probability 1', () => {
      const rng = new SeededRandom(42);
      for (let i = 0; i < 10; i++) {
        expect(randomChance(1, () => rng.next())).toBe(true);
      }
    });

    it('always returns false for probability 0', () => {
      const rng = new SeededRandom(42);
      for (let i = 0; i < 10; i++) {
        expect(randomChance(0, () => rng.next())).toBe(false);
      }
    });

    it('clamps probability below 0 to 0', () => {
      const rng = new SeededRandom(42);
      for (let i = 0; i < 10; i++) {
        expect(randomChance(-0.5, () => rng.next())).toBe(false);
        expect(randomChance(-100, () => rng.next())).toBe(false);
      }
    });

    it('clamps probability above 1 to 1', () => {
      const rng = new SeededRandom(42);
      for (let i = 0; i < 10; i++) {
        expect(randomChance(1.5, () => rng.next())).toBe(true);
        expect(randomChance(100, () => rng.next())).toBe(true);
      }
    });

    it('handles NaN by treating as 0', () => {
      const rng = new SeededRandom(42);
      expect(randomChance(NaN, () => rng.next())).toBe(false);
    });
  });

  describe('randomInt', () => {
    it('produces deterministic results with seeded RNG', () => {
      const rng1 = new SeededRandom(42);
      const rng2 = new SeededRandom(42);

      const results1: number[] = [];
      const results2: number[] = [];

      for (let i = 0; i < 10; i++) {
        results1.push(randomInt(1, 100, () => rng1.next()));
        results2.push(randomInt(1, 100, () => rng2.next()));
      }

      expect(results1).toEqual(results2);
    });

    it('returns values within the specified range', () => {
      const rng = new SeededRandom(42);
      for (let i = 0; i < 100; i++) {
        const result = randomInt(10, 20, () => rng.next());
        expect(result).toBeGreaterThanOrEqual(10);
        expect(result).toBeLessThan(20);
      }
    });

    it('returns min when max equals min', () => {
      const rng = new SeededRandom(42);
      expect(randomInt(5, 5, () => rng.next())).toBe(5);
      expect(randomInt(0, 0, () => rng.next())).toBe(0);
      expect(randomInt(-10, -10, () => rng.next())).toBe(-10);
    });

    it('returns min when max is less than min', () => {
      const rng = new SeededRandom(42);
      expect(randomInt(10, 5, () => rng.next())).toBe(10);
      expect(randomInt(100, 0, () => rng.next())).toBe(100);
    });
  });

  describe('sampleRandom', () => {
    it('produces deterministic results with seeded RNG', () => {
      const rng1 = new SeededRandom(42);
      const rng2 = new SeededRandom(42);
      const array = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

      const result1 = sampleRandom(array, 3, () => rng1.next());
      const result2 = sampleRandom(array, 3, () => rng2.next());

      expect(result1).toEqual(result2);
    });

    it('returns the requested number of samples', () => {
      const rng = new SeededRandom(42);
      const array = [1, 2, 3, 4, 5];
      const result = sampleRandom(array, 3, () => rng.next());
      expect(result).toHaveLength(3);
    });

    it('returns at most the array length elements', () => {
      const rng = new SeededRandom(42);
      const array = [1, 2, 3];
      const result = sampleRandom(array, 10, () => rng.next());
      expect(result).toHaveLength(3);
    });

    it('returns empty array for empty input', () => {
      const rng = new SeededRandom(42);
      const result = sampleRandom([], 3, () => rng.next());
      expect(result).toEqual([]);
    });
  });
});

describe('randomization with default RNG (Math.random)', () => {
  it('shuffleArray works without RNG parameter', () => {
    const array = [1, 2, 3, 4, 5];
    const result = shuffleArray(array);
    expect(result).toHaveLength(5);
    expect(result.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('pickRandom works without RNG parameter', () => {
    const array = ['a', 'b', 'c'];
    const result = pickRandom(array);
    expect(result).toBeDefined();
    expect(array).toContain(result!);
  });

  it('randomChance works without RNG parameter', () => {
    // Just ensure no errors - result is non-deterministic
    const result = randomChance(0.5);
    expect(typeof result).toBe('boolean');
  });

  it('randomInt works without RNG parameter', () => {
    const result = randomInt(1, 10);
    expect(result).toBeGreaterThanOrEqual(1);
    expect(result).toBeLessThan(10);
  });

  it('sampleRandom works without RNG parameter', () => {
    const array = [1, 2, 3, 4, 5];
    const result = sampleRandom(array, 3);
    expect(result).toHaveLength(3);
  });
});
