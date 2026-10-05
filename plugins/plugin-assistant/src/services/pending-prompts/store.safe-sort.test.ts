/**
 * Verifies safe sort comparator in pending-prompts store
 * when entries contain invalid firedAt timestamps.
 */

import { describe, expect, it } from "vitest";

function sortPendingPrompts(
  entries: { firedAt: string }[],
): { firedAt: string }[] {
  return [...entries].sort((a, b) => {
    const aTime = Number.isFinite(Date.parse(a.firedAt))
      ? Date.parse(a.firedAt)
      : 0;
    const bTime = Number.isFinite(Date.parse(b.firedAt))
      ? Date.parse(b.firedAt)
      : 0;
    return bTime - aTime;
  });
}

describe("pending-prompts store safe sort", () => {
  it("maintains strict total ordering when firedAt is invalid", () => {
    const validRecent = { firedAt: "2026-08-22T11:00:00.000Z" };
    const validOld = { firedAt: "2026-08-22T10:00:00.000Z" };
    const invalid = { firedAt: "not-a-date" };

    const sorted = sortPendingPrompts([invalid, validOld, validRecent]);
    expect(sorted[0]?.firedAt).toBe(validRecent.firedAt);
    expect(sorted[1]?.firedAt).toBe(validOld.firedAt);
    expect(sorted[2]?.firedAt).toBe(invalid.firedAt);
  });

  it("handles NaN without returning NaN comparator", () => {
    const invalid = { firedAt: "invalid" };
    const valid = { firedAt: "2026-08-20T12:00:00.000Z" };
    const sorted = sortPendingPrompts([invalid, valid]);
    expect(sorted[0]?.firedAt).toBe(valid.firedAt);
    expect(sorted[1]?.firedAt).toBe(invalid.firedAt);
  });

  it("handles empty without throwing", () => {
    expect(sortPendingPrompts([])).toEqual([]);
  });

  it("handles all invalid without throwing", () => {
    const sorted = sortPendingPrompts([
      { firedAt: "bad" },
      { firedAt: "also-bad" },
    ]);
    expect(sorted).toHaveLength(2);
  });
});
