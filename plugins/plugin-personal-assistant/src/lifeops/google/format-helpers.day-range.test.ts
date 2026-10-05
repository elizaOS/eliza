/**
 * The calendar "today" window is the owner's local calendar day in their zone,
 * independent of the host clock. Deterministic: fixed instants, real helper.
 */
import { describe, expect, it } from "vitest";
import { dayRange } from "./format-helpers.ts";

describe("dayRange", () => {
  it.each([
    // 21:00 in New York is already the next UTC date.
    [
      "America/New_York",
      "2026-10-03T01:00:00.000Z",
      0,
      "2026-10-02T04:00:00.000Z",
      "2026-10-03T04:00:00.000Z",
    ],
    // Spring-forward day is 23 hours long.
    [
      "America/New_York",
      "2026-03-08T15:00:00.000Z",
      0,
      "2026-03-08T05:00:00.000Z",
      "2026-03-09T04:00:00.000Z",
    ],
    [
      "Asia/Kolkata",
      "2026-10-02T20:00:00.000Z",
      0,
      "2026-10-02T18:30:00.000Z",
      "2026-10-03T18:30:00.000Z",
    ],
    [
      "Asia/Tokyo",
      "2026-10-02T12:00:00.000Z",
      1,
      "2026-10-02T15:00:00.000Z",
      "2026-10-03T15:00:00.000Z",
    ],
  ])(
    "%s at %s offset %i spans the owner's local day",
    (timeZone, nowIso, offset, timeMin, timeMax) => {
      expect(dayRange(offset, timeZone, new Date(nowIso))).toEqual({
        timeMin,
        timeMax,
      });
    },
  );
});
