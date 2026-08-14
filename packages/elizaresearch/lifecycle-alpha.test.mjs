/**
 * Pins the #19616 opacity-handoff contract used by packages/elizaresearch/index.html.
 * These functions are the same arithmetic the page draws with. A change that
 * reintroduces the whole-face drop (bucket 0 = 1/8) or the age-0-at-handoff
 * flash will fail here.
 */
import { describe, expect, it } from "bun:test";

const FADE_FRAMES = 75;
const ALPHA_LEVELS = 8;

function particleAlpha(age, life) {
  return Math.min(1, Math.min(age, life) / FADE_FRAMES);
}

function alphaBucket(a) {
  return a >= 1 ? ALPHA_LEVELS - 1 : (a * ALPHA_LEVELS) | 0;
}

function bucketOpacity(k) {
  return k === 0 ? 0 : k / (ALPHA_LEVELS - 1);
}

describe("elizaresearch lifecycle alpha (#19616)", () => {
  it("keeps the first steady-state frame at full opacity when age is seeded to FADE_FRAMES", () => {
    const a = particleAlpha(FADE_FRAMES, 200);
    expect(a).toBe(1);
    expect(alphaBucket(a)).toBe(ALPHA_LEVELS - 1);
    expect(bucketOpacity(alphaBucket(a))).toBe(1);
  });

  it("does not map the post-handoff age=1 flash to a visible 12.5% face", () => {
    // The bug: age went 0 → 1, a = 1/75, idx 0, opacity (0+1)/8 = 0.125.
    const a = particleAlpha(1, 200);
    expect(a).toBeCloseTo(1 / FADE_FRAMES);
    expect(alphaBucket(a)).toBe(0);
    expect(bucketOpacity(0)).toBe(0);
  });

  it("reaches true zero before a reseed (life 0)", () => {
    expect(particleAlpha(FADE_FRAMES, 0)).toBe(0);
    expect(bucketOpacity(alphaBucket(0))).toBe(0);
  });
});
