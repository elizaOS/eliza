import { describe, expect, it } from "vitest";
import {
  anls,
  bboxIoU,
  clickHit,
  exactMatch,
  iouHit,
  levenshtein,
  normaliseAnswer,
  osworldStepMatch,
  pointInBBox,
  relaxedNumeric,
  vqaSoftScore,
} from "../src/scorers/index.ts";

describe("normaliseAnswer", () => {
  it("strips articles, punctuation, and case", () => {
    expect(normaliseAnswer("The cat.")).toBe("cat");
    expect(normaliseAnswer("AN orange Sign!")).toBe("orange sign");
    expect(normaliseAnswer("  ")).toBe("");
  });
});

describe("vqaSoftScore", () => {
  it("returns 1 when ≥3 references match", () => {
    expect(
      vqaSoftScore("stop", [
        "stop",
        "stop",
        "stop",
        "yield",
        "stop",
        "no parking",
      ]),
    ).toBe(1);
  });
  it("scales to 1/3 with one match", () => {
    expect(vqaSoftScore("stop", ["stop", "yield", "go", "wait"])).toBeCloseTo(
      1 / 3,
    );
  });
  it("returns 0 with no match", () => {
    expect(vqaSoftScore("stop", ["yield", "go"])).toBe(0);
  });
  it("handles empty inputs safely", () => {
    expect(vqaSoftScore("", ["stop"])).toBe(0);
    expect(vqaSoftScore("stop", [])).toBe(0);
  });
});

describe("exactMatch", () => {
  it("hits 1 only on a normalised exact reference", () => {
    expect(exactMatch("Stop.", ["stop"])).toBe(1);
    expect(exactMatch("stop sign", ["stop"])).toBe(0);
  });
});

describe("levenshtein + anls", () => {
  it("levenshtein measures edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("abc", "abc")).toBe(0);
    expect(levenshtein("", "abc")).toBe(3);
  });
  it("anls scores 1 on exact match", () => {
    expect(anls("hello", ["hello"])).toBe(1);
  });
  it("anls returns 0 below the τ=0.5 threshold", () => {
    expect(anls("totally different", ["hello"])).toBe(0);
  });
  it("anls scores partial similarity above threshold", () => {
    const score = anls("Jon Smith", ["John Smith"]);
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });
});

describe("relaxedNumeric", () => {
  it("matches numeric answers within ±5%", () => {
    expect(relaxedNumeric("42", ["42"])).toBe(1);
    expect(relaxedNumeric("43", ["42"])).toBe(1);
    expect(relaxedNumeric("50", ["42"])).toBe(0);
  });
  it("strips currency / percent symbols", () => {
    expect(relaxedNumeric("$1,250.00", ["1250"])).toBe(1);
    expect(relaxedNumeric("35%", ["35"])).toBe(1);
  });
  it("falls back to exact-match for categorical answers", () => {
    expect(relaxedNumeric("increase", ["increased"])).toBe(0);
    expect(relaxedNumeric("Sales", ["sales"])).toBe(1);
  });
});

describe("ScreenSpot scoring", () => {
  it("pointInBBox checks containment", () => {
    expect(pointInBBox({ x: 10, y: 10 }, [0, 0, 20, 20])).toBe(true);
    expect(pointInBBox({ x: 30, y: 10 }, [0, 0, 20, 20])).toBe(false);
  });
  it("clickHit returns 0 when no click is provided", () => {
    expect(clickHit(undefined, [0, 0, 10, 10])).toBe(0);
  });
  it("bboxIoU computes intersection-over-union", () => {
    expect(bboxIoU([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(bboxIoU([0, 0, 10, 10], [10, 10, 20, 20])).toBe(0);
    expect(bboxIoU([0, 0, 10, 10], [5, 5, 15, 15])).toBeCloseTo(25 / 175);
  });
  it("iouHit thresholds at 0.5", () => {
    expect(iouHit([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iouHit([0, 0, 10, 10], [9, 9, 19, 19])).toBe(0);
  });
});

describe("osworldStepMatch", () => {
  it("scores 1 when predicted matches reference exactly", () => {
    const ref = [
      { type: "CLICK" as const, x: 100, y: 200 },
      { type: "DONE" as const },
    ];
    expect(osworldStepMatch(ref, ref)).toBe(1);
  });
  it("scores partial when prediction misses a step", () => {
    const ref = [
      { type: "CLICK" as const, x: 100, y: 200 },
      { type: "TYPING" as const, text: "hello" },
      { type: "DONE" as const },
    ];
    const pred = [
      { type: "CLICK" as const, x: 100, y: 200 },
      { type: "DONE" as const },
    ];
    expect(osworldStepMatch(pred, ref)).toBeCloseTo(2 / 3);
  });
  it("tolerates click coordinate jitter under 32px", () => {
    const pred = [{ type: "CLICK" as const, x: 110, y: 195 }];
    const ref = [{ type: "CLICK" as const, x: 100, y: 200 }];
    expect(osworldStepMatch(pred, ref)).toBe(1);
  });
  it("rejects clicks outside the tolerance", () => {
    const pred = [{ type: "CLICK" as const, x: 200, y: 400 }];
    const ref = [{ type: "CLICK" as const, x: 100, y: 200 }];
    expect(osworldStepMatch(pred, ref)).toBe(0);
  });
});
