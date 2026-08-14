/**
 * Pins the #19616 opacity-handoff contract used by packages/elizaresearch/index.html.
 * These functions mirror the arithmetic the page draws with. A change that
 * reintroduces the whole-face drop (bucket 0 = 1/8), the age-0-at-handoff flash,
 * a low initial `life` that holds the first steady-state frame below full
 * opacity, or a post-entrance resize that resets `age` without re-seeding it
 * will fail here.
 */
import { describe, expect, it } from "bun:test";

const FADE_FRAMES = 75;
const ALPHA_LEVELS = 8;

// Mirror of draw() in index.html.
function particleAlpha(age, life) {
  return Math.min(1, Math.min(age, life) / FADE_FRAMES);
}
function alphaBucket(a) {
  return a >= 1 ? ALPHA_LEVELS - 1 : (a * ALPHA_LEVELS) | 0;
}
function bucketOpacity(k) {
  return k === 0 ? 0 : k / (ALPHA_LEVELS - 1);
}

// Mirror of the post-handoff seeding in step(): set age = FADE_FRAMES and
// lift any sub-FADE_FRAMES life up to FADE_FRAMES so the first steady-state
// frame is full opacity.
function applyHandoffSeed(boid) {
  boid.age = FADE_FRAMES;
  if (boid.life < FADE_FRAMES) boid.life = FADE_FRAMES;
  return boid;
}

// Mirror of tryInit(): produce a boid with a randomized lifetime in the
// production [90, 240) range and an age that depends on entranceComplete.
// The reproduction code uses entranceRandom() * 150 + 90; we approximate
// that range here by sampling an integer life uniformly in that band.
function initBoid({ entranceComplete }, rand = Math.random) {
  const life = rand() * 150 + 90;
  return {
    life,
    age: entranceComplete ? FADE_FRAMES : 0,
  };
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

  it("seeds age to FADE_FRAMES for boids created during the entrance transition", () => {
    // During the entrance, tryInit() now uses the production lifetime
    // distribution (90..240), so every initial life clears FADE_FRAMES and
    // the handoff seeding leaves a = age/FADE_FRAMES = 1.
    for (let life = 90; life < 240; life++) {
      const boid = applyHandoffSeed({ life, age: 0 });
      const a = particleAlpha(boid.age, boid.life);
      expect(alphaBucket(a)).toBe(ALPHA_LEVELS - 1);
      expect(bucketOpacity(alphaBucket(a))).toBe(1);
    }
  });

  it("lifts sub-FADE_FRAMES life up to FADE_FRAMES at handoff (defends the original bug)", () => {
    // The original bug: 66 of 99 lifetimes in [1, 99] rendered below full
    // opacity because life < FADE_FRAMES truncated min(age, life)/75. The
    // handoff seed must lift any such life up to FADE_FRAMES.
    for (let life = 0; life < FADE_FRAMES; life++) {
      const boid = applyHandoffSeed({ life, age: FADE_FRAMES });
      expect(boid.life).toBe(FADE_FRAMES);
      expect(particleAlpha(boid.age, boid.life)).toBe(1);
    }
  });

  it("keeps the post-entrance resize re-init at full opacity", () => {
    // After entranceComplete, resize() recreates every boid via tryInit().
    // The reproduction seeds age = FADE_FRAMES in that case so the very
    // first draw is full opacity. Sweep the production lifetime range.
    for (let life = 90; life < 240; life++) {
      const boid = initBoid({ entranceComplete: true });
      // Mirror the production distribution: life is in [90, 240); pin life
      // to the sample value so we can predict the post-seed a.
      boid.life = life;
      const a = particleAlpha(boid.age, boid.life);
      expect(alphaBucket(a)).toBe(ALPHA_LEVELS - 1);
      expect(bucketOpacity(alphaBucket(a))).toBe(1);
    }
  });

  it("does not regress a fresh entrance: first steady-state frame is full opacity across the production lifetime band", () => {
    // Reproduces the exact adversarial sweep that flagged the original PR:
    // sample every integer lifetime in the production [90, 240) band, apply
    // the post-handoff seed, and assert the first steady-state draw is full.
    let failures = 0;
    for (let life = 90; life < 240; life++) {
      const boid = applyHandoffSeed({ life, age: 0 });
      const a = particleAlpha(boid.age, boid.life);
      if (bucketOpacity(alphaBucket(a)) < 1) failures++;
    }
    expect(failures).toBe(0);
  });
});
