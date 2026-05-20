/**
 * Entropy - Cryptographically-Secure Randomization
 *
 * Use for game-critical fairness requirements:
 * - Fair random selection of winners/losers
 * - Event cooldowns and probability-based triggers
 * - Weighted picks for market/game mechanics
 * - Seeded PRNG for reproducible testing
 *
 * For simple shuffling/variety in prompts, use `randomization.ts` instead.
 */

import { randomBytes } from 'crypto';

// =============================================================================
// Core Random
// =============================================================================

/**
 * Generate a cryptographically secure random number in [0, 1).
 * Use for game-critical fairness requirements where Math.random() is insufficient.
 *
 * @returns Random number between 0 (inclusive) and 1 (exclusive)
 */
export const secureRandom = (): number =>
  randomBytes(4).readUInt32BE(0) / 0x100000000;

/**
 * Generate a cryptographically secure random integer in [min, max] (inclusive).
 *
 * @param min - Minimum value (inclusive)
 * @param max - Maximum value (inclusive)
 * @returns Random integer in the specified range
 */
export const secureRandomInt = (min: number, max: number): number =>
  Math.floor(secureRandom() * (max - min + 1)) + min;

/**
 * Cryptographically secure Fisher-Yates shuffle.
 * Returns a new array with elements randomly reordered.
 *
 * @param array - Array to shuffle (not modified)
 * @returns New shuffled array
 */
export function secureShuffle<T>(array: readonly T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = secureRandomInt(0, i);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/**
 * Pick N random items from an array using secure randomness.
 *
 * @param array - Source array
 * @param n - Number of items to pick (must be >= 0)
 * @returns Array of N randomly selected items (empty if n <= 0)
 */
export function securePickN<T>(array: readonly T[], n: number): T[] {
  // Handle invalid or edge cases
  if (n <= 0) return [];
  if (n >= array.length) return secureShuffle(array);
  return secureShuffle(array).slice(0, n);
}

/**
 * Generate a random count with a bell-curve distribution.
 * Values near the middle of the range are more likely than extremes.
 *
 * @param min - Minimum count (inclusive)
 * @param max - Maximum count (inclusive)
 * @returns Random count biased toward the middle of the range
 */
export const biasedRandomCount = (min: number, max: number): number =>
  Math.floor(((secureRandom() + secureRandom()) / 2) * (max - min + 1)) + min;

// =============================================================================
// Weighted Selection
// =============================================================================

/**
 * Pick a random item from an array with weighted probability.
 * Items with higher weights are more likely to be selected.
 *
 * @param items - Array of items to pick from
 * @param weight - Function that returns the weight for each item
 * @returns A randomly selected item, weighted by the weight function
 * @throws Error if items array is empty
 *
 * @example
 * ```typescript
 * const questions = [{ priority: 'high' }, { priority: 'low' }];
 * const picked = weightedPick(questions, q => q.priority === 'high' ? 10 : 1);
 * ```
 */
export function weightedPick<T>(items: T[], weight: (item: T) => number): T {
  if (items.length === 0) throw new Error('Empty array');
  if (items.length === 1) return items[0]!;

  const weights = items.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[secureRandomInt(0, items.length - 1)]!;

  let r = secureRandom() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i]!;
    if (r <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/**
 * Create a weight function based on resolution urgency.
 * Items closer to resolution get higher weights.
 *
 * @param multiplier - How much to multiply the base urgency weight (default: 5)
 * @returns A weight function that can be used with weightedPick
 *
 * @example
 * ```typescript
 * const questions = [{ resolutionDate: new Date() }, { resolutionDate: null }];
 * const picked = weightedPick(questions, urgencyWeight(3));
 * ```
 */
export const urgencyWeight = (
  multiplier = 5
): (<T extends { resolutionDate?: Date | string | null }>(q: T) => number) => {
  const now = Date.now();
  return <T extends { resolutionDate?: Date | string | null }>(
    q: T
  ): number => {
    const rd = q.resolutionDate;
    if (!rd) return 1;
    const hours = (new Date(rd).getTime() - now) / 3600000;
    const urgency =
      hours < 1
        ? 1
        : hours < 6
          ? 0.8
          : hours < 24
            ? 0.6
            : hours < 72
              ? 0.4
              : 0.2;
    return 1 + urgency * multiplier;
  };
};

// =============================================================================
// Event Cooldowns
// =============================================================================

export interface EventCooldownState {
  lastOccurrence: number;
  minCooldown: number;
  baseProbability: number;
  decayRate: number;
  maxProbability: number;
}

/** Check if event should fire (mutates lastOccurrence on true) */
export function shouldFireEvent(
  state: EventCooldownState,
  now: number
): boolean {
  const elapsed = now - state.lastOccurrence;
  if (elapsed < state.minCooldown) return false;

  const prob = Math.min(
    state.maxProbability,
    state.baseProbability + (elapsed - state.minCooldown) * state.decayRate
  );

  if (secureRandom() < prob) {
    state.lastOccurrence = now;
    return true;
  }
  return false;
}

// =============================================================================
// Sentiment
// =============================================================================

/** Generate noisy sentiment signal (-1 to 1) */
export const generateSentimentSignal = (
  positive: boolean,
  strength: number,
  noise = 0.2
): number =>
  Math.max(
    -1,
    Math.min(
      1,
      (positive ? strength : -strength) + (secureRandom() - 0.5) * 2 * noise
    )
  );

// =============================================================================
// Seeded PRNG (testing)
// =============================================================================

/** Reproducible xorshift128+ PRNG */
export class SeededRandom {
  private s: [number, number];

  constructor(seed: number | string) {
    const n =
      typeof seed === 'string'
        ? seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
        : seed;
    this.s = [n ^ 0xdeadbeef, n ^ 0x12345678];
  }

  next(): number {
    let s1 = this.s[0]!;
    const s0 = this.s[1]!;
    this.s[0] = s0;
    s1 ^= s1 << 23;
    s1 ^= s1 >>> 17;
    s1 ^= s0;
    s1 ^= s0 >>> 26;
    this.s[1] = s1;
    return ((this.s[0]! + this.s[1]!) >>> 0) / 0xffffffff;
  }

  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  nextFloat(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.nextInt(0, arr.length - 1)]!;
  }

  shuffle<T>(arr: readonly T[]): T[] {
    const r = [...arr];
    for (let i = r.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      [r[i], r[j]] = [r[j]!, r[i]!];
    }
    return r;
  }
}
