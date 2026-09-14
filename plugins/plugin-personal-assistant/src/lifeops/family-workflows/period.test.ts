/** Exercises monthly packet selection and real timezone conversion at DST and year boundaries. */
import { describe, expect, it } from "vitest";
import {
  familyPacketCalendarWindow,
  nextFamilyPacketPeriod,
} from "./period.js";

describe("family packet calendar period", () => {
  it.each([
    [
      "2026-10-15T12:00:00Z",
      "2026-11",
      "2026-11-01T04:00:00.000Z",
      "2026-12-01T05:00:00.000Z",
    ],
    [
      "2026-02-15T12:00:00Z",
      "2026-03",
      "2026-03-01T05:00:00.000Z",
      "2026-04-01T04:00:00.000Z",
    ],
    [
      "2026-12-15T12:00:00Z",
      "2027-01",
      "2027-01-01T05:00:00.000Z",
      "2027-02-01T05:00:00.000Z",
    ],
    [
      "2026-10-01T02:00:00Z",
      "2026-10",
      "2026-10-01T04:00:00.000Z",
      "2026-11-01T04:00:00.000Z",
    ],
  ])(
    "queries the complete next local month from %s",
    (now, key, timeMin, timeMax) => {
      const period = nextFamilyPacketPeriod(new Date(now));
      expect(period.key).toBe(key);
      expect(familyPacketCalendarWindow(period)).toEqual({
        timeMin,
        timeMax,
        timeZone: "America/New_York",
      });
    },
  );
});
