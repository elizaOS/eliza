/**
 * Safe NaN handling for calendar-handler rankedEvents date tiebreaker.
 */
import { describe, expect, it } from "vitest";

function rankedSort(cands: { score: number; event: { startAt: string } }[]) {
  return [...cands].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const aTime = Date.parse(left.event.startAt);
    const bTime = Date.parse(right.event.startAt);
    const aSafe = Number.isFinite(aTime) ? aTime : 0;
    const bSafe = Number.isFinite(bTime) ? bTime : 0;
    return aSafe - bSafe;
  });
}

describe("calendar-handler ranked sort safe", () => {
  it("tiebreaker uses date asc, invalid first", () => {
    const out = rankedSort([
      { score: 10, event: { startAt: "2026-01-02T00:00:00.000Z" } },
      { score: 10, event: { startAt: "invalid" } },
      { score: 10, event: { startAt: "2026-01-01T00:00:00.000Z" } },
    ]);
    expect(out[0].event.startAt).toBe("invalid");
    expect(out[1].event.startAt).toBe("2026-01-01T00:00:00.000Z");
  });
  it("score precedence over date", () => {
    const out = rankedSort([
      { score: 5, event: { startAt: "2026-01-01T00:00:00.000Z" } },
      { score: 10, event: { startAt: "2026-01-03T00:00:00.000Z" } },
    ]);
    expect(out[0].score).toBe(10);
  });
});
