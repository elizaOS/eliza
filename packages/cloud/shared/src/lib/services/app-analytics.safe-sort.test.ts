/**
 * Verifies safe sort comparator in app analytics session rows
 * when session startedAt contains invalid ISO strings.
 */

import { describe, expect, it } from "vitest";

function sortSessions(sessions: { startedAt: string }[]): { startedAt: string }[] {
  return [...sessions].sort((a, b) => {
    const aTime = Number.isFinite(Date.parse(a.startedAt)) ? Date.parse(a.startedAt) : 0;
    const bTime = Number.isFinite(Date.parse(b.startedAt)) ? Date.parse(b.startedAt) : 0;
    return bTime - aTime;
  });
}

describe("app-analytics safe sort", () => {
  it("maintains strict total ordering when startedAt is invalid", () => {
    const validRecent = { startedAt: "2026-08-22T11:00:00.000Z" };
    const validOld = { startedAt: "2026-08-22T10:00:00.000Z" };
    const invalid = { startedAt: "not-a-date" };

    const sorted = sortSessions([invalid, validOld, validRecent]);
    expect(sorted[0]?.startedAt).toBe(validRecent.startedAt);
    expect(sorted[1]?.startedAt).toBe(validOld.startedAt);
    expect(sorted[2]?.startedAt).toBe(invalid.startedAt);
  });

  it("handles NaN without NaN comparator", () => {
    const invalid = { startedAt: "invalid" };
    const valid = { startedAt: "2026-08-20T12:00:00.000Z" };
    const sorted = sortSessions([invalid, valid]);
    expect(sorted[0]?.startedAt).toBe(valid.startedAt);
  });

  it("handles empty", () => {
    expect(sortSessions([])).toEqual([]);
  });
});
