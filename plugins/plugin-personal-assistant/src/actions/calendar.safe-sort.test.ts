/**
 * Safe NaN handling for calendar bulk reschedule sort.
 */
import { describe, expect, it } from "vitest";

function safeSort(events: { startAt: string }[]): string[] {
  return [...events]
    .sort((left, right) => {
      const aTime = Date.parse(left.startAt);
      const bTime = Date.parse(right.startAt);
      const aSafe = Number.isFinite(aTime) ? aTime : 0;
      const bSafe = Number.isFinite(bTime) ? bTime : 0;
      return aSafe - bSafe;
    })
    .map((e) => e.startAt);
}

describe("calendar bulk reschedule safe sort", () => {
  it("places invalid date at start (0 epoch)", () => {
    const out = safeSort([
      { startAt: "invalid" },
      { startAt: "2026-01-02T00:00:00.000Z" },
      { startAt: "2026-01-01T00:00:00.000Z" },
    ]);
    expect(out[0]).toBe("invalid");
    expect(out[1]).toBe("2026-01-01T00:00:00.000Z");
  });
  it("stable with all invalid", () => {
    const out = safeSort([{ startAt: "bad1" }, { startAt: "bad2" }]);
    expect(out.length).toBe(2);
  });
  it("does not produce NaN comparator", () => {
    const a = Date.parse("invalid");
    const b = Date.parse("2026-01-01T00:00:00.000Z");
    const diff = (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) ? b : 0);
    expect(Number.isFinite(diff)).toBe(true);
  });
});
