/**
 * Quantitative memory-recall scoring at the scenario-report boundary.
 * The cases are synthetic evaluator inputs; no model or storage collaborator is mocked.
 */
import { describe, expect, it } from "vitest";
import { scoreMemoryRecall } from "./memory-recall-metrics";

describe("scoreMemoryRecall", () => {
  it("reports recall, precision, and false-positive rate independently", () => {
    const result = scoreMemoryRecall([
      {
        id: "retained",
        response: "Your launch codename is Kingfisher.",
        expected: ["kingfisher"],
        forbidden: ["kestrel"],
      },
      {
        id: "superseded",
        response: "The corrected city is Atlanta, not Houston.",
        expected: ["atlanta"],
        forbidden: ["houston"],
      },
      {
        id: "forgotten",
        response: "I do not have that locker code.",
        expected: [],
        forbidden: ["7391"],
      },
      {
        id: "missed",
        response: "I cannot recall the tea preference.",
        expected: ["oolong"],
        forbidden: ["earl grey"],
      },
    ]);

    expect(result).toEqual({
      kind: "scored",
      caseCount: 4,
      expectedFactCount: 3,
      truePositiveCount: 2,
      falseNegativeCount: 1,
      falsePositiveCount: 1,
      precision: 2 / 3,
      recall: 2 / 3,
      falsePositiveRate: 1 / 4,
      cases: [
        { id: "retained", recalled: true, falsePositive: false },
        { id: "superseded", recalled: true, falsePositive: true },
        { id: "forgotten", recalled: true, falsePositive: false },
        { id: "missed", recalled: false, falsePositive: false },
      ],
    });
  });

  it("rejects an empty evaluation instead of fabricating perfect metrics", () => {
    expect(scoreMemoryRecall([])).toEqual({
      kind: "invalid",
      reason: "at least one recall case is required",
    });
  });
});
