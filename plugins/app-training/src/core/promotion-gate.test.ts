/**
 * Tests for the A/B promotion gate.
 *
 * The gate's job is binary: given an incumbent + candidate + scorer, return
 * `promote: boolean` plus the math used to decide. We exercise both directions
 * (better candidate → promote; worse candidate → reject) and the noise gate
 * itself (a candidate that improves but only within stddev range is rejected).
 */

import { describe, expect, it } from "vitest";
import type { OptimizationExample, PromptScorer } from "../optimizers/types.js";
import {
  DEFAULT_INCUMBENT_RESEEDS,
  DEFAULT_NOISE_THRESHOLD,
  evaluatePromotion,
} from "./promotion-gate.js";

/**
 * Build a deterministic scorer that returns a fixed score for each prompt.
 * Calls to the same prompt always produce the same value regardless of which
 * examples are passed — useful for promote/reject tests where we want exact
 * numerical equality.
 */
function makeFixedScorer(scoresByPrompt: Record<string, number>): PromptScorer {
  return async (prompt) => {
    const score = scoresByPrompt[prompt];
    if (typeof score !== "number") {
      throw new Error(`[test] no fixed score wired up for prompt "${prompt}"`);
    }
    return score;
  };
}

/**
 * Scorer that returns a different value on each call for the SAME prompt.
 * Lets us simulate scoring noise and confirm the gate's stddev arithmetic
 * actually fires.
 */
function makeSequentialScorer(
  sequenceByPrompt: Record<string, number[]>,
): PromptScorer {
  const counters: Record<string, number> = {};
  return async (prompt) => {
    const queue = sequenceByPrompt[prompt];
    if (!queue || queue.length === 0) {
      throw new Error(`[test] no sequence wired up for prompt "${prompt}"`);
    }
    const idx = counters[prompt] ?? 0;
    const value = queue[idx % queue.length];
    counters[prompt] = idx + 1;
    if (typeof value !== "number") {
      throw new Error(
        `[test] sequence for prompt "${prompt}" produced non-number`,
      );
    }
    return value;
  };
}

const dataset: OptimizationExample[] = [
  {
    id: "a",
    input: { user: "row a" },
    expectedOutput: "ref a",
  },
  {
    id: "b",
    input: { user: "row b" },
    expectedOutput: "ref b",
  },
  {
    id: "c",
    input: { user: "row c" },
    expectedOutput: "ref c",
  },
];

describe("evaluatePromotion", () => {
  it("promotes a candidate that beats the incumbent by more than the noise margin", async () => {
    // Incumbent always returns 0.5; stddev=0 → any positive delta promotes.
    const scorer = makeFixedScorer({
      incumbent: 0.5,
      candidate: 0.8,
    });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset,
      scorer,
    });
    expect(decision.promote).toBe(true);
    expect(decision.incumbentMeanScore).toBeCloseTo(0.5, 10);
    expect(decision.incumbentStdDev).toBeCloseTo(0, 10);
    expect(decision.candidateScore).toBeCloseTo(0.8, 10);
    expect(decision.delta).toBeCloseTo(0.3, 10);
    expect(decision.promotionMargin).toBeCloseTo(0, 10);
    expect(decision.incumbentReseeds).toBe(DEFAULT_INCUMBENT_RESEEDS);
    expect(decision.noiseThreshold).toBe(DEFAULT_NOISE_THRESHOLD);
    expect(decision.reason).toMatch(/beats incumbent/i);
  });

  it("rejects a candidate that regresses against the incumbent", async () => {
    const scorer = makeFixedScorer({
      incumbent: 0.7,
      candidate: 0.4,
    });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset,
      scorer,
    });
    expect(decision.promote).toBe(false);
    expect(decision.delta).toBeLessThan(0);
    expect(decision.reason).toMatch(/did not improve/i);
  });

  it("rejects a candidate whose improvement is inside the noise margin", async () => {
    // Incumbent scores oscillate around 0.5 with stddev ≈ 0.1.
    // Candidate scores 0.55 — better than mean, but the 1.5× margin = 0.15
    // pushes the bar to 0.65. Should reject.
    const scorer = makeSequentialScorer({
      incumbent: [0.4, 0.5, 0.6],
      candidate: [0.55],
    });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset,
      scorer,
    });
    expect(decision.incumbentMeanScore).toBeCloseTo(0.5, 10);
    // population stddev of [0.4, 0.5, 0.6] = sqrt((0.01+0+0.01)/3) ≈ 0.0816
    expect(decision.incumbentStdDev).toBeGreaterThan(0.05);
    expect(decision.candidateScore).toBeCloseTo(0.55, 10);
    expect(decision.delta).toBeCloseTo(0.05, 10);
    expect(decision.promote).toBe(false);
    expect(decision.reason).toMatch(/noise margin/i);
  });

  it("promotes when improvement clearly clears the noise margin", async () => {
    // Same incumbent variance as above, candidate jumps to 0.9.
    const scorer = makeSequentialScorer({
      incumbent: [0.4, 0.5, 0.6],
      candidate: [0.9],
    });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset,
      scorer,
    });
    expect(decision.promote).toBe(true);
    expect(decision.delta).toBeCloseTo(0.4, 10);
    expect(decision.delta).toBeGreaterThan(decision.promotionMargin);
  });

  it("does not promote when dataset is empty", async () => {
    const scorer = makeFixedScorer({ incumbent: 0.0, candidate: 1.0 });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset: [],
      scorer,
    });
    expect(decision.promote).toBe(false);
    expect(decision.incumbentReseeds).toBe(0);
    expect(decision.examplesPerPass).toBe(0);
    expect(decision.reason).toMatch(/empty/i);
  });

  it("respects a custom noiseThreshold of 0 (any positive delta promotes)", async () => {
    // With variance + 0 noise margin, a 0.05 improvement promotes.
    const scorer = makeSequentialScorer({
      incumbent: [0.4, 0.5, 0.6],
      candidate: [0.55],
    });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset,
      scorer,
      options: { noiseThreshold: 0 },
    });
    expect(decision.noiseThreshold).toBe(0);
    expect(decision.promotionMargin).toBe(0);
    expect(decision.promote).toBe(true);
  });

  it("respects a custom incumbentReseeds count", async () => {
    const scorer = makeSequentialScorer({
      incumbent: [0.5, 0.5, 0.5, 0.5, 0.5],
      candidate: [0.9],
    });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset,
      scorer,
      options: { incumbentReseeds: 5 },
    });
    expect(decision.incumbentReseeds).toBe(5);
    expect(decision.incumbentScores).toHaveLength(5);
  });

  it("honors scoringSubset for sampling cap", async () => {
    const scorer = makeFixedScorer({
      incumbent: 0.5,
      candidate: 0.9,
    });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset,
      scorer,
      options: { scoringSubset: 2, rng: makeDeterministicRng() },
    });
    expect(decision.examplesPerPass).toBe(2);
    expect(decision.promote).toBe(true);
  });

  it("floors incumbentReseeds at 1 even when caller supplies 0", async () => {
    const scorer = makeFixedScorer({ incumbent: 0.5, candidate: 0.9 });
    const decision = await evaluatePromotion({
      incumbentPrompt: "incumbent",
      candidatePrompt: "candidate",
      dataset,
      scorer,
      options: { incumbentReseeds: 0 },
    });
    expect(decision.incumbentReseeds).toBe(1);
    expect(decision.incumbentScores).toHaveLength(1);
  });
});

/**
 * Deterministic RNG for tests that exercise subsample sampling — keeps the
 * draws stable across runs so we don't get flaky cardinality assertions.
 */
function makeDeterministicRng(): () => number {
  let state = 0;
  return () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280;
  };
}
