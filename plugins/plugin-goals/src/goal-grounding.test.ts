import { describe, expect, it } from "vitest";
import {
  buildGoalGroundingMetadata,
  buildGoalSemanticReviewMetadata,
  mergeGoalGroundingMetadata,
  mergeGoalSemanticReviewMetadata,
  readGoalGroundingMetadata,
  readGoalSemanticReviewMetadata,
} from "./goal-grounding";

describe("goal grounding metadata", () => {
  describe("readGoalGroundingMetadata", () => {
    it("returns null for non-object input", () => {
      expect(readGoalGroundingMetadata(null)).toBeNull();
      expect(readGoalGroundingMetadata("grounded")).toBeNull();
      expect(readGoalGroundingMetadata(42)).toBeNull();
      expect(readGoalGroundingMetadata([])).toBeNull();
      expect(readGoalGroundingMetadata(undefined)).toBeNull();
    });

    it("returns null for an unknown grounding state (fail-closed)", () => {
      expect(readGoalGroundingMetadata({ groundingState: "bogus" })).toBeNull();
      expect(
        readGoalGroundingMetadata({ groundingState: "GROUNDED" }),
      ).toBeNull();
      expect(readGoalGroundingMetadata({ groundingState: "" })).toBeNull();
      expect(readGoalGroundingMetadata({ groundingState: "  " })).toBeNull();
    });

    it("normalizes valid records and dedupes arrays", () => {
      const result = readGoalGroundingMetadata({
        groundingState: "grounded",
        summary: "  on track  ",
        targetDomain: "health",
        confidence: 0.5,
        missingCriticalFields: ["a", "a", "b", "  "],
        evidenceSignals: ["x", "y", "x"],
        reviewCadenceKind: " weekly ",
      });
      expect(result).toEqual({
        version: 1,
        groundingState: "grounded",
        summary: "on track",
        targetDomain: "health",
        groundedAt: null,
        confidence: 0.5,
        missingCriticalFields: ["a", "b"],
        evidenceSignals: ["x", "y"],
        reviewCadenceKind: "weekly",
      });
    });

    it("clamps out-of-range confidence to [0,1]", () => {
      expect(
        readGoalGroundingMetadata({
          groundingState: "partial",
          confidence: 2,
        })?.confidence,
      ).toBe(1);
      expect(
        readGoalGroundingMetadata({
          groundingState: "partial",
          confidence: -3,
        })?.confidence,
      ).toBe(0);
    });

    it("treats non-finite confidence as absent", () => {
      expect(
        readGoalGroundingMetadata({
          groundingState: "grounded",
          confidence: Number.NaN,
        })?.confidence,
      ).toBeNull();
      expect(
        readGoalGroundingMetadata({
          groundingState: "grounded",
          confidence: Number.POSITIVE_INFINITY,
        })?.confidence,
      ).toBeNull();
      expect(
        readGoalGroundingMetadata({
          groundingState: "grounded",
          confidence: "0.5",
        })?.confidence,
      ).toBeNull();
    });

    it("reads the nested goalGrounding envelope", () => {
      const result = readGoalGroundingMetadata({
        unrelated: 1,
        goalGrounding: { groundingState: "ungrounded", summary: null },
      });
      expect(result?.groundingState).toBe("ungrounded");
    });
  });

  describe("readGoalSemanticReviewMetadata", () => {
    const valid = {
      reviewState: "on_track",
      reviewedAt: "2026-08-25T00:00:00Z",
      explanation: " good progress ",
      progressScore: 0.8,
      confidence: 0.9,
      missingEvidence: ["e1", "e1", "e2"],
      evidenceSummary: " three commits ",
      suggestions: [
        { title: " T1 ", detail: " d1 ", kind: "scope" },
        { title: "   ", detail: "x" },
        { title: "t2", detail: "  " },
        { title: "t3", detail: "d3" },
      ],
    };

    it("normalizes a valid record", () => {
      const result = readGoalSemanticReviewMetadata(valid);
      expect(result).toEqual({
        reviewedAt: "2026-08-25T00:00:00Z",
        reviewState: "on_track",
        progressScore: 0.8,
        confidence: 0.9,
        explanation: "good progress",
        evidenceSummary: "three commits",
        missingEvidence: ["e1", "e2"],
        suggestions: [
          { kind: "scope", title: "T1", detail: "d1" },
          { kind: null, title: "t3", detail: "d3" },
        ],
      });
    });

    it("clamps progressScore and confidence to [0,1]", () => {
      const result = readGoalSemanticReviewMetadata({
        ...valid,
        progressScore: 5,
        confidence: -1,
      });
      expect(result?.progressScore).toBe(1);
      expect(result?.confidence).toBe(0);
    });

    it("returns null when required fields are missing (fail-closed)", () => {
      expect(
        readGoalSemanticReviewMetadata({ ...valid, reviewState: undefined }),
      ).toBeNull();
      expect(
        readGoalSemanticReviewMetadata({ ...valid, reviewedAt: "" }),
      ).toBeNull();
      expect(
        readGoalSemanticReviewMetadata({
          ...valid,
          explanation: "   ",
        }),
      ).toBeNull();
      expect(
        readGoalSemanticReviewMetadata({ ...valid, reviewState: "bogus" }),
      ).toBeNull();
      expect(readGoalSemanticReviewMetadata("nope")).toBeNull();
      expect(readGoalSemanticReviewMetadata(null)).toBeNull();
    });

    it("reads the nested goalSemanticReview envelope", () => {
      const result = readGoalSemanticReviewMetadata({
        goalSemanticReview: valid,
      });
      expect(result?.reviewState).toBe("on_track");
    });

    it("drops non-object suggestions and suggestions without title/detail", () => {
      const result = readGoalSemanticReviewMetadata({
        ...valid,
        suggestions: [
          "string",
          42,
          null,
          { title: "kept", detail: "yes" },
          { title: null, detail: "x" },
          { title: "y", detail: undefined },
        ],
      });
      expect(result?.suggestions).toEqual([
        { kind: null, title: "kept", detail: "yes" },
      ]);
    });
  });

  describe("buildGoalGroundingMetadata", () => {
    it("clamps confidence and normalizes inputs", () => {
      const result = buildGoalGroundingMetadata({
        groundingState: "grounded",
        confidence: 1.5,
        missingCriticalFields: ["a", "a"],
        evidenceSignals: ["x", "x", "y"],
        reviewCadenceKind: " daily ",
      });
      expect(result.confidence).toBe(1);
      expect(result.missingCriticalFields).toEqual(["a"]);
      expect(result.evidenceSignals).toEqual(["x", "y"]);
      expect(result.reviewCadenceKind).toBe("daily");
    });

    it("nulls non-finite confidence and blank optional strings", () => {
      const result = buildGoalGroundingMetadata({
        groundingState: "partial",
        confidence: Number.NaN,
        reviewCadenceKind: "   ",
        summary: undefined,
      });
      expect(result.confidence).toBeNull();
      expect(result.reviewCadenceKind).toBeNull();
      expect(result.summary).toBeNull();
    });
  });

  describe("buildGoalSemanticReviewMetadata", () => {
    it("trims explanation, clamps scores, and filters blank suggestions", () => {
      const result = buildGoalSemanticReviewMetadata({
        reviewState: "at_risk",
        reviewedAt: "2026-08-25T00:00:00Z",
        explanation: " needs work ",
        progressScore: -0.2,
        confidence: 3,
        missingEvidence: ["m1", "m1"],
        suggestions: [
          { title: " t ", detail: " d " },
          { title: "  ", detail: "x" },
          { title: "y", detail: "  " },
        ],
      });
      expect(result.explanation).toBe("needs work");
      expect(result.progressScore).toBe(0);
      expect(result.confidence).toBe(1);
      expect(result.missingEvidence).toEqual(["m1"]);
      expect(result.suggestions).toEqual([
        { kind: null, title: "t", detail: "d" },
      ]);
    });
  });

  describe("merge helpers", () => {
    it("mergeGoalGroundingMetadata attaches the envelope", () => {
      const grounding = buildGoalGroundingMetadata({
        groundingState: "grounded",
      });
      expect(mergeGoalGroundingMetadata({ a: 1 }, grounding)).toEqual({
        a: 1,
        goalGrounding: grounding,
      });
    });

    it("mergeGoalSemanticReviewMetadata attaches the envelope", () => {
      const review = buildGoalSemanticReviewMetadata({
        reviewState: "idle",
        reviewedAt: "2026-08-25T00:00:00Z",
        explanation: "ok",
      });
      expect(mergeGoalSemanticReviewMetadata({ b: 2 }, review)).toEqual({
        b: 2,
        goalSemanticReview: review,
      });
    });
  });
});
