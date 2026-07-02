import { describe, expect, it } from "vitest";
import { scoreTriage } from "./metrics.ts";

const LABELS = ["a", "b", "c"] as const;

describe("scoreTriage", () => {
  it("computes per-class precision/recall on a known confusion", () => {
    // gold:      a a a b b c
    // predicted: a a b b c c
    const score = scoreTriage(
      LABELS,
      ["a", "a", "a", "b", "b", "c"],
      ["a", "a", "b", "b", "c", "c"],
    );
    expect(score.accuracy).toBeCloseTo(4 / 6, 12);
    expect(score.perClass.a?.precision).toBe(1);
    expect(score.perClass.a?.recall).toBeCloseTo(2 / 3, 12);
    expect(score.perClass.b?.precision).toBeCloseTo(1 / 2, 12);
    expect(score.perClass.b?.recall).toBeCloseTo(1 / 2, 12);
    expect(score.perClass.c?.precision).toBeCloseTo(1 / 2, 12);
    expect(score.perClass.c?.recall).toBe(1);
    expect(score.total).toBe(6);
    expect(score.correct).toBe(4);
  });

  it("scores a perfect run as all ones", () => {
    const score = scoreTriage(LABELS, ["a", "b", "c"], ["a", "b", "c"]);
    expect(score.accuracy).toBe(1);
    expect(score.macroF1).toBe(1);
    for (const label of LABELS) {
      expect(score.perClass[label]?.f1).toBe(1);
    }
  });

  it("defines precision as 1 for a never-predicted class and f1 as 0 for a never-hit one", () => {
    // gold has 'c' but prediction never emits it → recall 0, precision 1
    // (vacuous), f1 0 — never NaN.
    const score = scoreTriage(LABELS, ["a", "c"], ["a", "a"]);
    expect(score.perClass.c?.precision).toBe(1);
    expect(score.perClass.c?.recall).toBe(0);
    expect(score.perClass.c?.f1).toBe(0);
    expect(Number.isFinite(score.macroF1)).toBe(true);
  });

  it("rejects length mismatches, unknown labels, and empty corpora", () => {
    expect(() => scoreTriage(LABELS, ["a"], ["a", "b"])).toThrow(
      "length mismatch",
    );
    expect(() => scoreTriage(LABELS, ["z"], ["a"])).toThrow(
      "unknown gold label",
    );
    expect(() => scoreTriage(LABELS, ["a"], ["z"])).toThrow(
      "unknown predicted label",
    );
    expect(() => scoreTriage(LABELS, [], [])).toThrow("empty corpus");
  });
});
