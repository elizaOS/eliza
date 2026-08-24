/**
 * Unit coverage for the goal grounding / semantic-review metadata builders —
 * confidence clamping, array dedup, string trimming, and review-state
 * validation. These pure builders shape records persisted into agent memory,
 * so out-of-range scores, unnormalized arrays, and unvalidated review states
 * would corrupt downstream goal evaluation.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", () => ({
  LIFEOPS_REVIEW_STATES: ["idle", "needs_attention", "on_track", "at_risk"],
}));

import {
  buildGoalGroundingMetadata,
  buildGoalSemanticReviewMetadata,
  mergeGoalGroundingMetadata,
  mergeGoalSemanticReviewMetadata,
  readGoalGroundingMetadata,
  readGoalSemanticReviewMetadata,
} from "./goal-grounding.ts";

describe("buildGoalGroundingMetadata", () => {
  it("clamps confidence above 1 down to 1", () => {
    const meta = buildGoalGroundingMetadata({
      groundingState: "grounded",
      confidence: 1.7,
    });
    expect(meta.confidence).toBe(1);
  });

  it("clamps confidence below 0 up to 0", () => {
    const meta = buildGoalGroundingMetadata({
      groundingState: "grounded",
      confidence: -0.4,
    });
    expect(meta.confidence).toBe(0);
  });

  it("keeps in-range finite confidence", () => {
    const meta = buildGoalGroundingMetadata({
      groundingState: "partial",
      confidence: 0.55,
    });
    expect(meta.confidence).toBe(0.55);
  });

  it("maps non-finite confidence to null", () => {
    const meta = buildGoalGroundingMetadata({
      groundingState: "grounded",
      confidence: Number.NaN,
    });
    expect(meta.confidence).toBeNull();
  });

  it("maps Infinity confidence to null", () => {
    const meta = buildGoalGroundingMetadata({
      groundingState: "grounded",
      confidence: Number.POSITIVE_INFINITY,
    });
    expect(meta.confidence).toBeNull();
  });

  it("dedupes and filters falsy missingCriticalFields", () => {
    const meta = buildGoalGroundingMetadata({
      groundingState: "ungrounded",
      missingCriticalFields: ["a", "", "b", "a", null as unknown as string],
    });
    expect(meta.missingCriticalFields).toEqual(["a", "b"]);
  });

  it("dedupes evidenceSignals preserving first occurrence", () => {
    const meta = buildGoalGroundingMetadata({
      groundingState: "grounded",
      evidenceSignals: ["sig1", "sig2", "sig1"],
    });
    expect(meta.evidenceSignals).toEqual(["sig1", "sig2"]);
  });

  it("trims reviewCadenceKind and rejects blank strings", () => {
    expect(
      buildGoalGroundingMetadata({
        groundingState: "grounded",
        reviewCadenceKind: "  weekly  ",
      }).reviewCadenceKind,
    ).toBe("weekly");
    expect(
      buildGoalGroundingMetadata({
        groundingState: "grounded",
        reviewCadenceKind: "   ",
      }).reviewCadenceKind,
    ).toBeNull();
  });

  it("defaults omitted optional fields to null/[]", () => {
    const meta = buildGoalGroundingMetadata({ groundingState: "grounded" });
    expect(meta).toMatchObject({
      version: 1,
      groundingState: "grounded",
      summary: null,
      targetDomain: null,
      groundedAt: null,
      confidence: null,
      missingCriticalFields: [],
      evidenceSignals: [],
      reviewCadenceKind: null,
    });
  });
});

describe("mergeGoalGroundingMetadata", () => {
  it("attaches grounding under the goalGrounding key", () => {
    const merged = mergeGoalGroundingMetadata(
      { existing: 1 },
      buildGoalGroundingMetadata({ groundingState: "grounded" }),
    );
    expect(merged).toMatchObject({ existing: 1 });
    expect(merged.goalGrounding).toMatchObject({
      groundingState: "grounded",
      version: 1,
    });
  });
});

describe("readGoalGroundingMetadata", () => {
  it("round-trips a metadata record", () => {
    const built = buildGoalGroundingMetadata({
      groundingState: "partial",
      summary: "  needs review  ",
      targetDomain: "health",
      groundedAt: "2026-08-24",
      confidence: 0.8,
      missingCriticalFields: ["evidence"],
      evidenceSignals: ["signal"],
      reviewCadenceKind: "daily",
    });
    const read = readGoalGroundingMetadata({ goalGrounding: built });
    expect(read).not.toBeNull();
    expect(read!.groundingState).toBe("partial");
    expect(read!.summary).toBe("needs review");
    expect(read!.confidence).toBe(0.8);
    expect(read!.missingCriticalFields).toEqual(["evidence"]);
  });

  it("returns null for a non-object value", () => {
    expect(readGoalGroundingMetadata("nope")).toBeNull();
  });

  it("returns null for an unknown groundingState", () => {
    const read = readGoalGroundingMetadata({
      goalGrounding: { groundingState: "mystical" },
    });
    expect(read).toBeNull();
  });

  it("returns null for a missing groundingState", () => {
    const read = readGoalGroundingMetadata({
      goalGrounding: { summary: "x" },
    });
    expect(read).toBeNull();
  });

  it("reads a bare record without the goalGrounding wrapper", () => {
    const read = readGoalGroundingMetadata({
      groundingState: "grounded",
      confidence: 0.3,
    });
    expect(read).not.toBeNull();
    expect(read!.groundingState).toBe("grounded");
  });

  it("clamps an out-of-range confidence on read", () => {
    const read = readGoalGroundingMetadata({
      goalGrounding: { groundingState: "grounded", confidence: 5 },
    });
    expect(read!.confidence).toBe(1);
  });

  it("rejects non-string array entries on read", () => {
    const read = readGoalGroundingMetadata({
      goalGrounding: {
        groundingState: "grounded",
        missingCriticalFields: ["a", 42, "b"],
      },
    });
    expect(read!.missingCriticalFields).toEqual(["a", "b"]);
  });
});

describe("buildGoalSemanticReviewMetadata", () => {
  it("clamps progressScore and confidence into [0, 1]", () => {
    const review = buildGoalSemanticReviewMetadata({
      reviewedAt: "2026-08-24T00:00:00Z",
      reviewState: "on_track",
      progressScore: 2,
      confidence: -3,
      explanation: "  looks good  ",
    });
    expect(review.progressScore).toBe(1);
    expect(review.confidence).toBe(0);
    expect(review.explanation).toBe("looks good");
  });

  it("maps non-finite progressScore to null", () => {
    const review = buildGoalSemanticReviewMetadata({
      reviewedAt: "2026-08-24T00:00:00Z",
      reviewState: "at_risk",
      progressScore: Number.NaN,
      explanation: "x",
    });
    expect(review.progressScore).toBeNull();
  });

  it("dedupes and filters missingEvidence", () => {
    const review = buildGoalSemanticReviewMetadata({
      reviewedAt: "2026-08-24T00:00:00Z",
      reviewState: "needs_attention",
      missingEvidence: ["e1", "", "e1"],
      explanation: "x",
    });
    expect(review.missingEvidence).toEqual(["e1"]);
  });

  it("filters suggestions with blank title or detail", () => {
    const review = buildGoalSemanticReviewMetadata({
      reviewedAt: "2026-08-24T00:00:00Z",
      reviewState: "idle",
      explanation: "x",
      suggestions: [
        { kind: "a", title: "  T1  ", detail: "D1" },
        { kind: "b", title: "", detail: "D2" },
        { kind: "c", title: "T3", detail: "   " },
      ],
    });
    expect(review.suggestions).toEqual([
      { kind: "a", title: "T1", detail: "D1" },
    ]);
  });

  it("trims suggestion title and detail", () => {
    const review = buildGoalSemanticReviewMetadata({
      reviewedAt: "2026-08-24T00:00:00Z",
      reviewState: "on_track",
      explanation: "x",
      suggestions: [{ kind: null, title: "  T  ", detail: "  D  " }],
    });
    expect(review.suggestions).toEqual([
      { kind: null, title: "T", detail: "D" },
    ]);
  });
});

describe("mergeGoalSemanticReviewMetadata", () => {
  it("attaches review under the goalSemanticReview key", () => {
    const merged = mergeGoalSemanticReviewMetadata(
      { existing: true },
      buildGoalSemanticReviewMetadata({
        reviewedAt: "2026-08-24T00:00:00Z",
        reviewState: "at_risk",
        explanation: "x",
      }),
    );
    expect(merged.existing).toBe(true);
    expect(merged.goalSemanticReview).toMatchObject({
      reviewState: "at_risk",
      explanation: "x",
    });
  });
});

describe("readGoalSemanticReviewMetadata", () => {
  it("round-trips a full review record", () => {
    const built = buildGoalSemanticReviewMetadata({
      reviewedAt: "2026-08-24T00:00:00Z",
      reviewState: "needs_attention",
      progressScore: 0.4,
      confidence: 0.9,
      explanation: "E",
      evidenceSummary: "S",
      missingEvidence: ["m"],
      suggestions: [{ kind: "k", title: "T", detail: "D" }],
    });
    const read = readGoalSemanticReviewMetadata({ goalSemanticReview: built });
    expect(read).not.toBeNull();
    expect(read!.reviewState).toBe("needs_attention");
    expect(read!.progressScore).toBe(0.4);
    expect(read!.suggestions).toEqual([{ kind: "k", title: "T", detail: "D" }]);
  });

  it("returns null for an unknown reviewState", () => {
    const read = readGoalSemanticReviewMetadata({
      goalSemanticReview: {
        reviewedAt: "2026-08-24T00:00:00Z",
        reviewState: "nonsense",
        explanation: "E",
      },
    });
    expect(read).toBeNull();
  });

  it("returns null when explanation is missing", () => {
    const read = readGoalSemanticReviewMetadata({
      goalSemanticReview: {
        reviewedAt: "2026-08-24T00:00:00Z",
        reviewState: "on_track",
      },
    });
    expect(read).toBeNull();
  });

  it("returns null when reviewedAt is missing", () => {
    const read = readGoalSemanticReviewMetadata({
      goalSemanticReview: { reviewState: "on_track", explanation: "E" },
    });
    expect(read).toBeNull();
  });

  it("filters malformed suggestion entries on read", () => {
    const read = readGoalSemanticReviewMetadata({
      goalSemanticReview: {
        reviewedAt: "2026-08-24T00:00:00Z",
        reviewState: "at_risk",
        explanation: "E",
        suggestions: [
          { title: "T1", detail: "D1" },
          { title: "", detail: "D2" },
          "garbage",
          null,
        ],
      },
    });
    expect(read!.suggestions).toEqual([
      { kind: null, title: "T1", detail: "D1" },
    ]);
  });

  it("clamps an out-of-range progressScore on read", () => {
    const read = readGoalSemanticReviewMetadata({
      goalSemanticReview: {
        reviewedAt: "2026-08-24T00:00:00Z",
        reviewState: "on_track",
        explanation: "E",
        progressScore: 99,
      },
    });
    expect(read!.progressScore).toBe(1);
  });
});
