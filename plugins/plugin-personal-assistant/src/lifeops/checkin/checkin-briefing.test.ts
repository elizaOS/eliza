/** Verifies check-in briefing item ranking before the report is serialized for the summary model. */
import { describe, expect, it } from "vitest";
import {
  type BriefingSortSignals,
  buildBriefingSignals,
  sortBriefingItems,
  toFiniteNonNegativeNumber,
} from "./checkin-briefing-ranking.js";
import { clip } from "./checkin-service.js";
import type { CheckinBriefingItem } from "./types.js";

function item(
  title: string,
  occurredAt: string,
  signals = buildBriefingSignals({ occurredAt }),
): CheckinBriefingItem & {
  sort: BriefingSortSignals;
} {
  return {
    title,
    detail: "urgent asap deadline please reply?",
    occurredAt,
    href: null,
    reason: signals.reason,
    signals: signals.signals,
    sort: { ...signals.signals, occurredAt },
  };
}

describe("check-in briefing ranking", () => {
  it("does not promote keyword-only text before the summary model sees it", () => {
    const ranked = buildBriefingSignals({
      occurredAt: "2026-01-01T00:00:00.000Z",
    });

    expect(ranked.reason).toBeNull();
    expect(ranked.signals.replyNeeded).toBeUndefined();
    expect(ranked.signals.important).toBeUndefined();
  });

  it("keeps collector-sized sections instead of silently cutting to eight items", () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      item(
        `message ${index}`,
        `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      ),
    );

    expect(sortBriefingItems(items)).toHaveLength(10);
  });

  it("orders by typed reply-needed signal before recency", () => {
    const olderReplyNeeded = item(
      "older reply-needed",
      "2026-01-01T00:00:00.000Z",
      buildBriefingSignals({
        occurredAt: "2026-01-01T00:00:00.000Z",
        replyNeeded: true,
      }),
    );
    const newerObservation = item(
      "newer observation",
      "2026-01-02T00:00:00.000Z",
    );

    expect(
      sortBriefingItems([newerObservation, olderReplyNeeded])[0]?.title,
    ).toBe("older reply-needed");
  });

  it("normalizes missing metric counts instead of producing NaN engagement", () => {
    expect(toFiniteNonNegativeNumber(undefined)).toBe(0);
    expect(toFiniteNonNegativeNumber(Number.NaN)).toBe(0);
    expect(toFiniteNonNegativeNumber(-3)).toBe(0);
    expect(toFiniteNonNegativeNumber(7)).toBe(7);
  });
});

describe("check-in item detail clip", () => {
  it("never splits surrogate pairs at the truncation boundary", () => {
    const text = `${"a".repeat(216)}🦊${"b".repeat(50)}`;
    const clipped = clip(text, 220);
    expect(clipped.isWellFormed()).toBe(true);
    expect(clipped).toBe(`${"a".repeat(216)}...`);
    expect(clipped.length).toBe(219);
  });

  it("sanitizes lone surrogates before clipping", () => {
    const text = `bad ${String.fromCharCode(0xd800)} item detail`;
    const clipped = clip(text, 220);
    expect(clipped.isWellFormed()).toBe(true);
    expect(clipped).toBe("bad \uFFFD item detail");
  });

  it("preserves fitting emoji without truncation", () => {
    const text = "meeting with team 🦊";
    const clipped = clip(text, 220);
    expect(clipped).toBe("meeting with team 🦊");
    expect(clipped.isWellFormed()).toBe(true);
  });

  it("handles boundary lengths and edge cases cleanly", () => {
    expect(clip("hello", 0)).toBe("");
    expect(clip("hello", -1)).toBe("");
    expect(clip("hello", 2)).toBe("..");
    expect(clip("hello", 3)).toBe("...");
    expect(clip("hello", 5)).toBe("hello");
  });
});
