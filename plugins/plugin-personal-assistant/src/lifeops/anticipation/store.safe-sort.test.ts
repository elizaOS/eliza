/**
 * Verifies safe sort comparator in anticipation dispatch markers
 * when markers contain invalid firedAt timestamps.
 */

import { describe, expect, it } from "vitest";

function liveMarkers(
  markers: { firedAt: string }[],
  now: Date,
): { firedAt: string }[] {
  const MARKER_RETENTION_HOURS = 24;
  const cutoffMs = now.getTime() - MARKER_RETENTION_HOURS * 3_600_000;
  return markers
    .filter((marker) => {
      const firedMs = Date.parse(marker.firedAt);
      return Number.isFinite(firedMs) && firedMs >= cutoffMs;
    })
    .sort((a, b) => {
      const aTime = Number.isFinite(Date.parse(a.firedAt))
        ? Date.parse(a.firedAt)
        : 0;
      const bTime = Number.isFinite(Date.parse(b.firedAt))
        ? Date.parse(b.firedAt)
        : 0;
      return aTime - bTime;
    });
}

describe("anticipation store safe sort", () => {
  it("maintains ordering when firedAt is invalid", () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    const validOld = { firedAt: "2026-08-22T10:00:00.000Z" };
    const validRecent = { firedAt: "2026-08-22T11:00:00.000Z" };
    const invalid = { firedAt: "not-a-date" };

    const result = liveMarkers([invalid, validRecent, validOld], now);
    expect(result).toHaveLength(2);
    expect(result[0]?.firedAt).toBe(validOld.firedAt);
    expect(result[1]?.firedAt).toBe(validRecent.firedAt);
  });

  it("filters invalid and sorts strict total ordering", () => {
    const now = new Date("2026-08-22T12:00:00.000Z");
    const markers = [
      { firedAt: "invalid" },
      { firedAt: "2026-08-22T09:00:00.000Z" },
      { firedAt: "2026-08-22T11:00:00.000Z" },
    ];
    const result = liveMarkers(markers, now);
    expect(result.map((m) => m.firedAt)).toEqual([
      "2026-08-22T09:00:00.000Z",
      "2026-08-22T11:00:00.000Z",
    ]);
  });

  it("handles empty without throwing", () => {
    expect(liveMarkers([], new Date())).toEqual([]);
  });
});
