/**
 * Opt-in determinism helpers for component tests.
 *
 * The repo's UI has timing-sensitive code (startup-phase polling reads
 * `Date.now()` deadlines), so we do NOT freeze the clock globally — that would
 * break those tests. Instead, tests that render clock/random-derived UI opt in
 * here. The frozen instant matches the browser determinism shim used by the
 * story gate (`test/story-gate/determinism-shim.mjs`), so a component renders
 * identically under vitest and under the visual gate.
 *
 * Usage:
 *   import { withFrozenClock, seedMathRandom } from "../../test/determinism";
 *   beforeEach(() => withFrozenClock());   // auto-restored via afterEach hook
 *
 * Or scoped:
 *   const restore = freezeClock();
 *   // ... render ...
 *   restore();
 */
import { afterEach, vi } from "vitest";

/** 2025-06-01T12:00:00.000Z — identical to the story-gate shim. */
export const FROZEN_EPOCH_MS = 1748779200000;
export const FROZEN_ISO = "2025-06-01T12:00:00.000Z";

/**
 * Freeze ONLY `Date` (not setTimeout/setInterval), so `Date.now()` and
 * `new Date()` are constant while real timers keep working. Returns a restore
 * fn. Prefer `withFrozenClock()` which registers cleanup automatically.
 */
export function freezeClock(epochMs: number = FROZEN_EPOCH_MS): () => void {
  vi.useFakeTimers({ toFake: ["Date"], now: epochMs });
  return () => vi.useRealTimers();
}

/** `freezeClock` with automatic `afterEach` restoration. */
export function withFrozenClock(epochMs: number = FROZEN_EPOCH_MS): void {
  freezeClock(epochMs);
  afterEach(() => vi.useRealTimers());
}

/**
 * Replace `Math.random` with a seeded mulberry32 PRNG (matches the browser
 * shim's algorithm and seed by default). Returns a restore fn.
 */
export function seedMathRandom(seed = 0x9e3779b9): () => void {
  const original = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => {
    Math.random = original;
  };
}

/** `seedMathRandom` with automatic `afterEach` restoration. */
export function withSeededRandom(seed = 0x9e3779b9): void {
  const restore = seedMathRandom(seed);
  afterEach(restore);
}
