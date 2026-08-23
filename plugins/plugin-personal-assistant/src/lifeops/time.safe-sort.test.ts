/**
 * Unit tests for timezone local parts candidate disambiguation in buildUtcDateFromLocalParts.
 */
import { describe, expect, it } from "vitest";
import { buildUtcDateFromLocalParts } from "./time";

describe("buildUtcDateFromLocalParts DST disambiguation and safe sort", () => {
  it("resolves ambiguous local time during DST fold (fall back) by picking the earlier instant", () => {
    // In America/New_York, 2026-11-01 01:30:00 happens twice (EDT UTC-4 at 05:30Z and EST UTC-5 at 06:30Z).
    // Compatible disambiguation must select the earlier instant (05:30:00Z).
    const date = buildUtcDateFromLocalParts("America/New_York", {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
      second: 0,
    });

    expect(date.toISOString()).toBe("2026-11-01T05:30:00.000Z");
  });

  it("resolves nonexistent local time during DST gap (spring forward) by advancing past the gap", () => {
    // In America/New_York, 2026-03-08 02:30:00 does not exist (clocks jump from 02:00 to 03:00).
    // Compatible disambiguation shifts forward by the gap to 03:30 EDT (07:30:00Z).
    const date = buildUtcDateFromLocalParts("America/New_York", {
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
      second: 0,
    });

    expect(date.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});
