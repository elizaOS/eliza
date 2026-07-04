/**
 * RRULE recurrence module — parse/normalize validation, DST-correct expansion,
 * next-occurrence, and COUNT/UNTIL termination.
 *
 * DST facts used below (America/New_York, 2026): spring-forward on Sunday
 * 2026-03-08 (EST→EDT, UTC-5→UTC-4), fall-back on Sunday 2026-11-01
 * (EDT→EST). A recurring 9am local event is 14:00Z under EST and 13:00Z under
 * EDT — the expansion must keep 9am local (exactly one fire per local day,
 * never a double-fire or a skip), mirroring the scheduled-task cron DST fix.
 */

import { describe, expect, it } from "vitest";
import { CalendarServiceError } from "../src/internal/errors.js";
import {
  describeRecurrence,
  expandRecurrenceOccurrences,
  firstRecurrenceRule,
  nextRecurrenceOccurrence,
  normalizeRecurrence,
  normalizeRecurrenceScope,
  parseRecurrenceRule,
  recurrenceLinesFrom,
  recurringEventIdFrom,
} from "../src/internal/recurrence.js";

const NY = "America/New_York";

function isoAll(dates: Date[]): string[] {
  return dates.map((date) => date.toISOString());
}

describe("parseRecurrenceRule", () => {
  it("parses a weekly BYDAY rule with and without the RRULE: prefix", () => {
    for (const line of [
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE",
      "FREQ=WEEKLY;BYDAY=MO,WE",
    ]) {
      const rule = parseRecurrenceRule(line);
      expect(rule.freq).toBe("WEEKLY");
      expect(rule.interval).toBe(1);
      expect(rule.byDay).toEqual([1, 3]);
      expect(rule.beyondExpansionSubset).toBe(false);
    }
  });

  it("parses INTERVAL, COUNT, UNTIL (date and datetime), BYMONTHDAY", () => {
    expect(parseRecurrenceRule("RRULE:FREQ=DAILY;INTERVAL=3").interval).toBe(3);
    expect(parseRecurrenceRule("RRULE:FREQ=DAILY;COUNT=5").count).toBe(5);
    expect(
      parseRecurrenceRule("RRULE:FREQ=DAILY;UNTIL=20260310T140000Z").untilMs,
    ).toBe(Date.UTC(2026, 2, 10, 14, 0, 0));
    expect(parseRecurrenceRule("RRULE:FREQ=DAILY;UNTIL=20260310").untilMs).toBe(
      Date.UTC(2026, 2, 10, 23, 59, 59),
    );
    expect(
      parseRecurrenceRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=15,-1").byMonthDay,
    ).toEqual([15, -1]);
  });

  it("flags provider-valid parts outside the local expansion subset", () => {
    expect(
      parseRecurrenceRule("RRULE:FREQ=MONTHLY;BYDAY=2MO").beyondExpansionSubset,
    ).toBe(true);
    expect(
      parseRecurrenceRule("RRULE:FREQ=YEARLY;BYMONTH=3").beyondExpansionSubset,
    ).toBe(true);
  });

  it("rejects malformed rules with a 400 CalendarServiceError", () => {
    const invalid = [
      "",
      "RRULE:",
      "RRULE:FREQ=HOURLY",
      "RRULE:BYDAY=MO",
      "RRULE:FREQ=WEEKLY;BYDAY=XX",
      "RRULE:FREQ=DAILY;INTERVAL=0",
      "RRULE:FREQ=DAILY;COUNT=0",
      "RRULE:FREQ=DAILY;UNTIL=tomorrow",
      "RRULE:FREQ=DAILY;COUNT=3;UNTIL=20260310",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=0",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=45",
      "RRULE:FREQ=DAILY;NONSENSE=1",
      "every tuesday at 9",
    ];
    for (const line of invalid) {
      expect(() => parseRecurrenceRule(line), line).toThrowError(
        CalendarServiceError,
      );
      try {
        parseRecurrenceRule(line);
      } catch (error) {
        expect((error as CalendarServiceError).status).toBe(400);
      }
    }
  });
});

describe("normalizeRecurrence", () => {
  it("canonicalizes strings and arrays to uppercase RRULE: lines", () => {
    expect(normalizeRecurrence("freq=weekly;byday=mo")).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
    ]);
    expect(normalizeRecurrence(["rrule:freq=daily;count=10"])).toEqual([
      "RRULE:FREQ=DAILY;COUNT=10",
    ]);
  });

  it("passes EXDATE/RDATE lines through and drops empties", () => {
    expect(
      normalizeRecurrence([
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=America/New_York:20260316T090000",
        "  ",
      ]),
    ).toEqual([
      "RRULE:FREQ=WEEKLY;BYDAY=MO",
      "EXDATE;TZID=America/New_York:20260316T090000",
    ]);
  });

  it("returns undefined for empty input and throws for junk", () => {
    expect(normalizeRecurrence(undefined)).toBeUndefined();
    expect(normalizeRecurrence(null)).toBeUndefined();
    expect(normalizeRecurrence([])).toBeUndefined();
    expect(normalizeRecurrence(["   "])).toBeUndefined();
    expect(() => normalizeRecurrence("weekly on mondays")).toThrowError(
      CalendarServiceError,
    );
    expect(() => normalizeRecurrence([42])).toThrowError(CalendarServiceError);
  });
});

describe("expandRecurrenceOccurrences — DST boundaries", () => {
  it("keeps 9am local across the spring-forward boundary (one per day)", () => {
    // 2026-03-06T09:00 EST = 14:00Z; DST starts Sunday 2026-03-08.
    const rule = parseRecurrenceRule("RRULE:FREQ=DAILY");
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2026-03-06T14:00:00.000Z"),
      timeZone: NY,
      rangeEnd: new Date("2026-03-11T00:00:00.000Z"),
    });
    expect(isoAll(occurrences)).toEqual([
      "2026-03-06T14:00:00.000Z", // Fri 09:00 EST
      "2026-03-07T14:00:00.000Z", // Sat 09:00 EST
      "2026-03-08T13:00:00.000Z", // Sun 09:00 EDT — offset shifts, local time holds
      "2026-03-09T13:00:00.000Z", // Mon 09:00 EDT
      "2026-03-10T13:00:00.000Z", // Tue 09:00 EDT
    ]);
  });

  it("keeps 9am local across the fall-back boundary (no double-fire)", () => {
    // 2026-10-30T09:00 EDT = 13:00Z; DST ends Sunday 2026-11-01.
    const rule = parseRecurrenceRule("RRULE:FREQ=DAILY");
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2026-10-30T13:00:00.000Z"),
      timeZone: NY,
      rangeEnd: new Date("2026-11-04T00:00:00.000Z"),
    });
    expect(isoAll(occurrences)).toEqual([
      "2026-10-30T13:00:00.000Z", // Fri 09:00 EDT
      "2026-10-31T13:00:00.000Z", // Sat 09:00 EDT
      "2026-11-01T14:00:00.000Z", // Sun 09:00 EST — exactly one fire
      "2026-11-02T14:00:00.000Z", // Mon 09:00 EST
      "2026-11-03T14:00:00.000Z", // Tue 09:00 EST
    ]);
  });

  it("expands weekly BYDAY across the DST boundary", () => {
    // Monday 2026-03-02T09:00 EST; next Mondays fall after spring-forward.
    const rule = parseRecurrenceRule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2026-03-02T14:00:00.000Z"),
      timeZone: NY,
      rangeEnd: new Date("2026-03-17T00:00:00.000Z"),
    });
    expect(isoAll(occurrences)).toEqual([
      "2026-03-02T14:00:00.000Z", // Mon 09:00 EST
      "2026-03-09T13:00:00.000Z", // Mon 09:00 EDT
      "2026-03-16T13:00:00.000Z", // Mon 09:00 EDT
    ]);
  });
});

describe("expandRecurrenceOccurrences — rule semantics", () => {
  it("honors COUNT termination (DTSTART counts as the first occurrence)", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=DAILY;COUNT=3");
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2026-03-06T14:00:00.000Z"),
      timeZone: NY,
      rangeEnd: new Date("2027-01-01T00:00:00.000Z"),
    });
    expect(occurrences).toHaveLength(3);
    expect(occurrences.at(-1)?.toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("honors UNTIL termination inclusively across the DST shift", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=DAILY;UNTIL=20260310T140000Z");
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2026-03-06T14:00:00.000Z"),
      timeZone: NY,
      rangeEnd: new Date("2027-01-01T00:00:00.000Z"),
    });
    // Mar 10 09:00 EDT = 13:00Z <= UNTIL 14:00Z → included; Mar 11 excluded.
    expect(isoAll(occurrences)).toEqual([
      "2026-03-06T14:00:00.000Z",
      "2026-03-07T14:00:00.000Z",
      "2026-03-08T13:00:00.000Z",
      "2026-03-09T13:00:00.000Z",
      "2026-03-10T13:00:00.000Z",
    ]);
  });

  it("expands every-2-weeks BYDAY pairs from the anchor week", () => {
    // Wednesday 2026-06-03T09:00 EDT = 13:00Z; anchor week is Jun 1 (Mon).
    const rule = parseRecurrenceRule(
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
    );
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2026-06-03T13:00:00.000Z"),
      timeZone: NY,
      rangeEnd: new Date("2026-07-01T00:00:00.000Z"),
    });
    // Week 0: Jun 1 (before DTSTART → dropped), Jun 3 (DTSTART).
    // Week 2: Jun 15, Jun 17. Week 4: Jun 29.
    expect(isoAll(occurrences)).toEqual([
      "2026-06-03T13:00:00.000Z",
      "2026-06-15T13:00:00.000Z",
      "2026-06-17T13:00:00.000Z",
      "2026-06-29T13:00:00.000Z",
    ]);
  });

  it("skips months without the anchor day for MONTHLY day-31 rules", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=MONTHLY");
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2026-01-31T14:00:00.000Z"), // Jan 31, 09:00 EST
      timeZone: NY,
      rangeEnd: new Date("2026-06-15T00:00:00.000Z"),
    });
    // Feb and Apr have no day 31 → skipped per RFC 5545.
    expect(isoAll(occurrences)).toEqual([
      "2026-01-31T14:00:00.000Z",
      "2026-03-31T13:00:00.000Z", // EDT
      "2026-05-31T13:00:00.000Z", // EDT
    ]);
  });

  it("resolves negative BYMONTHDAY (-1 = last day of month)", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1");
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2026-01-31T14:00:00.000Z"),
      timeZone: NY,
      rangeEnd: new Date("2026-04-01T00:00:00.000Z"),
    });
    expect(isoAll(occurrences)).toEqual([
      "2026-01-31T14:00:00.000Z",
      "2026-02-28T14:00:00.000Z",
      "2026-03-31T13:00:00.000Z",
    ]);
  });

  it("skips Feb 29 anniversaries in non-leap years for YEARLY rules", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=YEARLY");
    const occurrences = expandRecurrenceOccurrences({
      rule,
      startAt: new Date("2024-02-29T14:00:00.000Z"),
      timeZone: NY,
      rangeEnd: new Date("2029-01-01T00:00:00.000Z"),
    });
    expect(isoAll(occurrences)).toEqual([
      "2024-02-29T14:00:00.000Z",
      "2028-02-29T14:00:00.000Z",
    ]);
  });
});

describe("nextRecurrenceOccurrence", () => {
  it("finds the next weekly occurrence after a given instant", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=WEEKLY;BYDAY=MO");
    const next = nextRecurrenceOccurrence({
      rule,
      startAt: new Date("2026-03-02T14:00:00.000Z"),
      timeZone: NY,
      after: new Date("2026-03-03T00:00:00.000Z"),
    });
    expect(next?.toISOString()).toBe("2026-03-09T13:00:00.000Z");
  });

  it("finds the next monthly occurrence across a short month", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=MONTHLY");
    const next = nextRecurrenceOccurrence({
      rule,
      startAt: new Date("2026-01-31T14:00:00.000Z"),
      timeZone: NY,
      after: new Date("2026-02-01T00:00:00.000Z"),
    });
    expect(next?.toISOString()).toBe("2026-03-31T13:00:00.000Z");
  });

  it("returns null once COUNT/UNTIL terminate the series", () => {
    const counted = parseRecurrenceRule("RRULE:FREQ=DAILY;COUNT=2");
    expect(
      nextRecurrenceOccurrence({
        rule: counted,
        startAt: new Date("2026-03-06T14:00:00.000Z"),
        timeZone: NY,
        after: new Date("2026-03-07T14:00:00.000Z"),
      }),
    ).toBeNull();

    const bounded = parseRecurrenceRule(
      "RRULE:FREQ=DAILY;UNTIL=20260307T140000Z",
    );
    expect(
      nextRecurrenceOccurrence({
        rule: bounded,
        startAt: new Date("2026-03-06T14:00:00.000Z"),
        timeZone: NY,
        after: new Date("2026-03-07T14:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("returns null instead of guessing for beyond-subset rules", () => {
    const rule = parseRecurrenceRule("RRULE:FREQ=MONTHLY;BYDAY=2MO");
    expect(
      nextRecurrenceOccurrence({
        rule,
        startAt: new Date("2026-03-09T13:00:00.000Z"),
        timeZone: NY,
        after: new Date("2026-03-10T00:00:00.000Z"),
      }),
    ).toBeNull();
  });
});

describe("describeRecurrence", () => {
  it("describes common rules", () => {
    expect(describeRecurrence(["RRULE:FREQ=DAILY"])).toBe("daily");
    expect(describeRecurrence(["RRULE:FREQ=DAILY;INTERVAL=2"])).toBe(
      "every 2 days",
    );
    expect(describeRecurrence(["RRULE:FREQ=WEEKLY;BYDAY=MO"])).toBe(
      "weekly on Monday",
    );
    expect(
      describeRecurrence(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"]),
    ).toBe("every 2 weeks on Monday and Wednesday");
    expect(describeRecurrence(["RRULE:FREQ=MONTHLY;BYMONTHDAY=15"])).toBe(
      "monthly on day 15",
    );
    expect(describeRecurrence(["RRULE:FREQ=DAILY;COUNT=10"])).toBe(
      "daily, 10 times",
    );
    expect(describeRecurrence(["RRULE:FREQ=WEEKLY;UNTIL=20260901"])).toBe(
      "weekly until Sep 1, 2026",
    );
  });

  it("returns null for empty input and skips EXDATE-only sets", () => {
    expect(describeRecurrence(null)).toBeNull();
    expect(describeRecurrence([])).toBeNull();
    expect(
      describeRecurrence(["EXDATE;TZID=America/New_York:20260316T090000"]),
    ).toBeNull();
  });
});

describe("scope + event helpers", () => {
  it("normalizes recurrence scopes and fails closed on junk", () => {
    expect(normalizeRecurrenceScope(undefined)).toBeUndefined();
    expect(normalizeRecurrenceScope("")).toBeUndefined();
    expect(normalizeRecurrenceScope("instance")).toBe("instance");
    expect(normalizeRecurrenceScope("Occurrence")).toBe("instance");
    expect(normalizeRecurrenceScope("SERIES")).toBe("series");
    expect(normalizeRecurrenceScope("all")).toBe("series");
    expect(() => normalizeRecurrenceScope("everything")).toThrowError(
      CalendarServiceError,
    );
    expect(() => normalizeRecurrenceScope(7)).toThrowError(
      CalendarServiceError,
    );
  });

  it("reads recurringEventId and recurrence from fields or metadata", () => {
    expect(
      recurringEventIdFrom({ recurringEventId: "master-1", metadata: {} }),
    ).toBe("master-1");
    expect(
      recurringEventIdFrom({ metadata: { recurringEventId: "master-2" } }),
    ).toBe("master-2");
    expect(recurringEventIdFrom({ metadata: {} })).toBeNull();
    expect(recurringEventIdFrom(null)).toBeNull();

    expect(
      recurrenceLinesFrom({ recurrence: ["RRULE:FREQ=DAILY"], metadata: {} }),
    ).toEqual(["RRULE:FREQ=DAILY"]);
    expect(
      recurrenceLinesFrom({
        metadata: { recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", 42] },
      }),
    ).toEqual(["RRULE:FREQ=WEEKLY;BYDAY=MO"]);
    expect(recurrenceLinesFrom({ metadata: {} })).toBeNull();
  });

  it("parses the first RRULE line out of a mixed recurrence set", () => {
    const rule = firstRecurrenceRule([
      "EXDATE;TZID=UTC:20260316T090000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU",
    ]);
    expect(rule?.freq).toBe("WEEKLY");
    expect(rule?.byDay).toEqual([2]);
  });
});
