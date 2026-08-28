import { describe, expect, it } from "vitest";
import {
  type ImplicitReferentCandidate,
  resolveImplicitReferent,
} from "./index.js";

function candidate(
  over: Partial<ImplicitReferentCandidate> = {},
): ImplicitReferentCandidate {
  return {
    id: "c1",
    source: "owner_fact",
    label: "forward guidance",
    summary: "market briefing",
    confirmation: "forward guidance",
    ...over,
  };
}

const NOW = "2026-08-25T12:00:00.000Z";

describe("resolveImplicitReferent", () => {
  it("rejects an invalid nowIso with a labeled error", () => {
    expect(() =>
      resolveImplicitReferent({
        ask: "war",
        nowIso: "not-a-date",
        candidates: [],
      }),
    ).toThrow(/invalid nowIso/);
  });

  it("asks a question when there are no candidates", () => {
    const result = resolveImplicitReferent({
      ask: "war",
      nowIso: NOW,
      candidates: [],
    });
    expect(result.decision).toBe("ask");
    if (result.decision === "ask") {
      expect(result.question).toContain("Which context");
    }
  });

  it("asks when the only match is a substring inside another word", () => {
    // "war" is a substring of "forward" — a word-boundary-aware matcher must
    // not credit this candidate, so it stays below minConfidence and we ask.
    const candidates = [candidate({ prior: 1 })];
    const result = resolveImplicitReferent({
      ask: "war",
      nowIso: NOW,
      candidates,
    });
    expect(result.decision).toBe("ask");
    expect(result.ranked[0].score).toBeLessThan(0.62);
  });

  it("resolves when ask tokens match whole words", () => {
    const candidates = [
      candidate({
        id: "c1",
        source: "owner_fact",
        label: "forward guidance",
        summary: "market briefing",
        prior: 0,
      }),
      candidate({
        id: "c2",
        source: "recent_thread",
        label: "war room briefing",
        summary: "daily war update",
        prior: 1,
      }),
    ];
    const result = resolveImplicitReferent({
      ask: "war update",
      nowIso: NOW,
      candidates,
    });
    expect(result.decision).toBe("resolved");
    if (result.decision === "resolved") {
      expect(result.selected.candidate.id).toBe("c2");
    }
  });

  it("resolves a high-confidence single match", () => {
    const candidates = [
      candidate({
        id: "c1",
        label: "the quarterly report",
        summary: "q2 numbers",
        tags: ["quarterly"],
        prior: 1,
      }),
      candidate({ id: "c2", label: "the other thing", summary: "unrelated" }),
    ];
    const result = resolveImplicitReferent({
      ask: "the quarterly report",
      nowIso: NOW,
      candidates,
    });
    expect(result.decision).toBe("resolved");
    if (result.decision === "resolved") {
      expect(result.selected.candidate.id).toBe("c1");
      expect(result.selected.score).toBeGreaterThanOrEqual(0.62);
    }
  });

  it("asks for disambiguation when the top two scores are within the margin", () => {
    const candidates = [
      candidate({ id: "c1", label: "alpha report", summary: "alpha summary" }),
      candidate({ id: "c2", label: "alpha briefing", summary: "alpha notes" }),
    ];
    const result = resolveImplicitReferent({
      ask: "alpha",
      nowIso: NOW,
      candidates,
    });
    expect(result.decision).toBe("ask");
  });

  it("clamps the final score to 1 and folds in prior/recency evidence", () => {
    const candidates = [
      candidate({
        id: "c1",
        label: "the war briefing",
        summary: "war status update",
        prior: 5,
        occurredAt: "2026-08-24T12:00:00.000Z",
      }),
    ];
    const result = resolveImplicitReferent({
      ask: "war briefing",
      nowIso: NOW,
      candidates,
    });
    expect(result.decision).toBe("resolved");
    if (result.decision === "resolved") {
      expect(result.selected.score).toBeLessThanOrEqual(1);
      expect(result.selected.evidence.some((e) => e.startsWith("prior="))).toBe(
        true,
      );
      expect(
        result.selected.evidence.some((e) => e.startsWith("recency=")),
      ).toBe(true);
    }
  });

  it("rejects an invalid occurredAt on a candidate", () => {
    expect(() =>
      resolveImplicitReferent({
        ask: "war",
        nowIso: NOW,
        candidates: [candidate({ occurredAt: "garbage" })],
      }),
    ).toThrow();
  });
});
