/**
 * Randomization Utilities (Math.random-based)
 *
 * Fast, non-cryptographic randomization for general use cases:
 * - Shuffling arrays for prompt variety
 * - Sampling random elements for content generation
 * - Adding entropy to prevent repetitive AI outputs
 *
 * All functions accept an optional `rng` parameter for deterministic behavior
 * when using a seeded PRNG (e.g., SeededRandom from entropy.ts).
 *
 * For cryptographically-secure randomization (e.g., game fairness),
 * use the functions in `entropy.ts` instead.
 */

import { clamp01 } from './math-utils';

/**
 * Type alias for a random number generator function.
 * Returns a number in [0, 1) range.
 * Compatible with Math.random and SeededRandom.next().
 */
export type RngFunction = () => number;

/**
 * Fisher-Yates shuffle algorithm
 *
 * Randomly shuffles array in-place and returns it.
 * Creates a copy to avoid mutating the original array.
 *
 * @param array - Array to shuffle
 * @param rng - Optional random number generator (defaults to Math.random)
 * @returns New shuffled array (original array unchanged)
 * @throws Never throws - returns empty array if input is empty
 *
 * @example
 * ```typescript
 * const shuffled = shuffleArray([1, 2, 3, 4, 5]);
 * // Returns: [3, 1, 5, 2, 4] (random order)
 *
 * // With seeded RNG for deterministic results:
 * const rng = new SeededRandom(42);
 * const shuffled = shuffleArray([1, 2, 3, 4, 5], () => rng.next());
 * ```
 */
export function shuffleArray<T>(
  array: T[],
  rng: RngFunction = Math.random
): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = temp;
  }
  return shuffled;
}

/**
 * Get N random samples from an array without replacement
 *
 * Returns a random subset of the array without duplicates.
 *
 * @param array - Array to sample from
 * @param count - Number of samples to return
 * @param rng - Optional random number generator (defaults to Math.random)
 * @returns Array of random samples (may be shorter than count if array is smaller)
 * @throws Never throws - returns empty array if input is empty or count is 0
 *
 * @example
 * ```typescript
 * const samples = sampleRandom([1, 2, 3, 4, 5], 3);
 * // Returns: [2, 5, 1] (3 random elements)
 * ```
 */
export function sampleRandom<T>(
  array: T[],
  count: number,
  rng: RngFunction = Math.random
): T[] {
  const shuffled = shuffleArray(array, rng);
  return shuffled.slice(0, Math.min(count, array.length));
}

/**
 * Get a single random element from an array
 *
 * @param array - Array to pick from
 * @param rng - Optional random number generator (defaults to Math.random)
 * @returns Random element or undefined if array is empty
 *
 * @example
 * ```typescript
 * const item = pickRandom([1, 2, 3, 4, 5]);
 * // Returns: 3 (random element)
 * ```
 */
export function pickRandom<T>(
  array: T[],
  rng: RngFunction = Math.random
): T | undefined {
  if (array.length === 0) return undefined;
  return array[Math.floor(rng() * array.length)];
}

/**
 * Randomly decide with a given probability (0-1)
 *
 * Returns true with probability p, false otherwise.
 *
 * @param probability - Probability between 0 and 1
 * @param rng - Optional random number generator (defaults to Math.random)
 * @returns True with given probability, false otherwise
 * @throws Never throws - clamps probability to [0, 1] range
 *
 * @example
 * ```typescript
 * if (randomChance(0.3)) {
 *   // 30% chance this executes
 * }
 * ```
 */
export function randomChance(
  probability: number,
  rng: RngFunction = Math.random
): boolean {
  // Clamp probability to [0, 1] range (handles NaN by coercing to 0)
  const clampedProbability = clamp01(probability || 0);
  return rng() < clampedProbability;
}

/**
 * Get random integer between min (inclusive) and max (exclusive)
 *
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (exclusive)
 * @param rng - Optional random number generator (defaults to Math.random)
 * @returns Random integer in range [min, max)
 * @throws Never throws - returns min if max <= min
 *
 * @example
 * ```typescript
 * const roll = randomInt(1, 7); // Random dice roll: 1-6
 * ```
 */
export function randomInt(
  min: number,
  max: number,
  rng: RngFunction = Math.random
): number {
  // Handle invalid ranges: return min if max <= min
  if (max <= min) return min;
  return Math.floor(rng() * (max - min)) + min;
}
