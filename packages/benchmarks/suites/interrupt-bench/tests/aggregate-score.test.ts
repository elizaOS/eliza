// Exercises interrupt-bench benchmark interrupt bench tests aggregate score.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import { aggregateScore } from "../src/report.js";
import type { ScenarioResult } from "../src/types.js";

/**
 * Interrupt-bench aggregate scoring: a weight-averaged base score (0-100), a -5
 * penalty per boundary violation, and a judge bonus normalized to a +5 cap. The
 * final score is clamped at 0. Mis-weighting here distorts the benchmark verdict.
 */

const r = (over: Partial<ScenarioResult>): ScenarioResult =>
  ({ score: 1, weight: 1, boundaryViolated: false, ...over }) as ScenarioResult;

describe("aggregateScore", () => {
  it("returns zeros for no results", () => {
    expect(aggregateScore([])).toEqual({
      aggregate: 0,
      judgeBonus: 0,
      finalScore: 0,
    });
  });

  it("weight-averages the base score to 0-100", () => {
    expect(aggregateScore([r({ score: 1 })]).aggregate).toBe(100);
    expect(aggregateScore([r({ score: 0.5 })]).aggregate).toBe(50);
    // weighted: (1*2 + 0*1) / 3 → 66.67
    expect(
      aggregateScore([r({ score: 1, weight: 2 }), r({ score: 0, weight: 1 })])
        .aggregate,
    ).toBeCloseTo(66.667, 2);
  });

  it("subtracts 5 per boundary violation, clamps at 0", () => {
    expect(
      aggregateScore([r({ score: 1, boundaryViolated: true })]).finalScore,
    ).toBe(95);
    // heavy penalty floors at 0.
    expect(
      aggregateScore([
        r({ score: 0, boundaryViolated: true }),
        r({ score: 0, boundaryViolated: true }),
      ]).finalScore,
    ).toBe(0);
  });

  it("adds a normalized judge bonus", () => {
    const out = aggregateScore([
      r({ score: 1, judge: { pass: true } as never }),
    ]);
    expect(out.judgeBonus).toBe(5);
    expect(out.finalScore).toBe(105);
  });
});
