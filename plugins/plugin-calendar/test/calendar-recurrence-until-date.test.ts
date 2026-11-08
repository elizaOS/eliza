/** DATE UNTIL ends with its calendar day in the series time zone. */
import { describe, expect, it } from "vitest";
import {
  expandRecurrenceOccurrences,
  nextRecurrenceOccurrence,
  parseRecurrenceRule,
} from "../src/internal/recurrence.js";

const ZONE = "America/New_York";
// Daily 20:00 local. DTSTART Dec 10 20:00 EST = Dec 11 01:00Z.
const START = new Date("2026-12-11T01:00:00.000Z");
// After the Dec 14 occurrence (Dec 15 01:00Z).
const AFTER = new Date("2026-12-15T01:00:00.000Z");

describe("DATE UNTIL day boundary", () => {
  it("returns the Dec 15 20:00 local occurrence", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=DAILY;UNTIL=20261215");
    const next = nextRecurrenceOccurrence({
      rule,
      startAt: START,
      timeZone: ZONE,
      after: AFTER,
      nonexistentLocalTime: "shift-forward",
    });
    // Dec 15 20:00 EST = Dec 16 01:00Z; Dec 15 is the UNTIL date in-zone.
    expect(next?.toISOString()).toBe("2026-12-16T01:00:00.000Z");
  });

  it("control: expandRecurrenceOccurrences includes that occurrence", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=DAILY;UNTIL=20261215");
    const all = expandRecurrenceOccurrences({
      rule,
      startAt: START,
      timeZone: ZONE,
      rangeEnd: new Date("2027-01-01T00:00:00.000Z"),
      nonexistentLocalTime: "shift-forward",
    }).map((d) => d.toISOString());
    expect(all).toContain("2026-12-16T01:00:00.000Z");
    expect(all).toHaveLength(6);
  });

  it("does not admit the morning after UNTIL east of UTC", () => {
    // Daily 08:00 in Seoul (UTC+9). UNTIL=20261215 ends Dec 15 in-zone, so
    // the Dec 16 08:00 KST occurrence (Dec 15 23:00Z, inside the UTC cutoff)
    // must still be excluded.
    const rule = parseRecurrenceRule("RRULE:FREQ=DAILY;UNTIL=20261215");
    const next = nextRecurrenceOccurrence({
      rule,
      startAt: new Date("2026-12-09T23:00:00.000Z"),
      timeZone: "Asia/Seoul",
      after: new Date("2026-12-14T23:00:00.000Z"),
      nonexistentLocalTime: "shift-forward",
    });
    expect(next).toBeNull();
  });
});
