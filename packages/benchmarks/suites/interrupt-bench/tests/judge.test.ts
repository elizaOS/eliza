// Exercises interrupt-bench benchmark interrupt bench tests judge.test behavior against deterministic harness fixtures.
import { describe, expect, it } from "vitest";
import { normalizeJudgeResult } from "../src/judge.ts";

describe("normalizeJudgeResult", () => {
  it("reads valid judge fields", () => {
    expect(
      normalizeJudgeResult({
        pass: true,
        reason: "The reply satisfied the rubric.",
      }),
    ).toEqual({
      pass: true,
      reason: "The reply satisfied the rubric.",
    });
  });

  it("defaults malformed judge fields without throwing", () => {
    expect(normalizeJudgeResult({ pass: "yes", reason: 7 })).toEqual({
      pass: false,
      reason: "(no reason returned)",
    });
  });
});
