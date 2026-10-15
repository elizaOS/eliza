/**
 * Spring-forward gap handling in local recurrence expansion: provider split
 * plans shift the gap occurrence (RFC 5545 §3.3.5), ICS feeds skip it per RFC 5545
 * §3.3.10 without consuming COUNT.
 */

import { describe, expect, it } from "vitest";
import {
  buildRecurrenceSplitPlan,
  expandRecurrenceOccurrences,
  nextRecurrenceOccurrence,
  parseRecurrenceRule,
} from "../src/internal/recurrence.js";

const ZONE = "America/New_York";
// 02:30 local does not exist on 2026-03-08 in New York (02:00 -> 03:00).
const START = new Date("2026-03-07T07:30:00.000Z");
const RANGE_END = new Date("2026-04-01T00:00:00.000Z");
const COUNT_RULE = "RRULE:FREQ=DAILY;COUNT=5";
const isoList = (dates: Date[]) => dates.map((date) => date.toISOString());

describe("recurrence expansion across a spring-forward gap", () => {
  it("shifts the gap occurrence past the gap and counts it", () => {
    expect(
      isoList(
        expandRecurrenceOccurrences({
          rule: parseRecurrenceRule(COUNT_RULE),
          startAt: START,
          timeZone: ZONE,
          rangeEnd: RANGE_END,
          nonexistentLocalTime: "shift-forward",
        }),
      ),
    ).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
      "2026-03-11T06:30:00.000Z",
    ]);
  });

  it("skips the gap occurrence without consuming COUNT", () => {
    expect(
      isoList(
        expandRecurrenceOccurrences({
          rule: parseRecurrenceRule(COUNT_RULE),
          startAt: START,
          timeZone: ZONE,
          rangeEnd: RANGE_END,
          nonexistentLocalTime: "skip",
        }),
      ),
    ).toEqual([
      "2026-03-07T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
      "2026-03-11T06:30:00.000Z",
      "2026-03-12T06:30:00.000Z",
    ]);
  });

  it("skips a gap occurrence in a WEEKLY COUNT rule", () => {
    expect(
      isoList(
        expandRecurrenceOccurrences({
          rule: parseRecurrenceRule("RRULE:FREQ=WEEKLY;COUNT=3"),
          startAt: new Date("2026-03-01T07:30:00.000Z"),
          timeZone: ZONE,
          rangeEnd: RANGE_END,
          nonexistentLocalTime: "skip",
        }),
      ),
    ).toEqual([
      "2026-03-01T07:30:00.000Z",
      "2026-03-15T06:30:00.000Z",
      "2026-03-22T06:30:00.000Z",
    ]);
  });

  it("does not count a skipped gap date that falls before rangeStart", () => {
    const rangeStart = new Date("2026-03-12T00:00:00.000Z");
    const expand = (nonexistentLocalTime: "shift-forward" | "skip") =>
      isoList(
        expandRecurrenceOccurrences({
          rule: parseRecurrenceRule(COUNT_RULE),
          startAt: START,
          timeZone: ZONE,
          rangeStart,
          rangeEnd: RANGE_END,
          nonexistentLocalTime,
        }),
      );
    expect(expand("skip")).toEqual(["2026-03-12T06:30:00.000Z"]);
    expect(expand("shift-forward")).toEqual([]);
  });

  it("keeps a repeated fall-back time as one occurrence when skipping gaps", () => {
    // 01:30 occurs twice on 2026-11-01 in New York; the earlier one is kept.
    expect(
      isoList(
        expandRecurrenceOccurrences({
          rule: parseRecurrenceRule("RRULE:FREQ=DAILY;COUNT=3"),
          startAt: new Date("2026-10-31T05:30:00.000Z"),
          timeZone: ZONE,
          rangeEnd: new Date("2026-11-10T00:00:00.000Z"),
          nonexistentLocalTime: "skip",
        }),
      ),
    ).toEqual([
      "2026-10-31T05:30:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });

  it("finds the next occurrence under each policy", () => {
    const counted = parseRecurrenceRule(COUNT_RULE);
    const afterLast = new Date("2026-03-11T07:00:00.000Z");
    expect(
      nextRecurrenceOccurrence({
        rule: counted,
        startAt: START,
        timeZone: ZONE,
        after: afterLast,
        nonexistentLocalTime: "skip",
      })?.toISOString(),
    ).toBe("2026-03-12T06:30:00.000Z");
    expect(
      nextRecurrenceOccurrence({
        rule: counted,
        startAt: START,
        timeZone: ZONE,
        after: afterLast,
      }),
    ).toBeNull();

    const unbounded = parseRecurrenceRule("RRULE:FREQ=DAILY");
    const afterStart = new Date("2026-03-07T08:00:00.000Z");
    expect(
      nextRecurrenceOccurrence({
        rule: unbounded,
        startAt: START,
        timeZone: ZONE,
        after: afterStart,
        nonexistentLocalTime: "skip",
      })?.toISOString(),
    ).toBe("2026-03-09T06:30:00.000Z");
    expect(
      nextRecurrenceOccurrence({
        rule: unbounded,
        startAt: START,
        timeZone: ZONE,
        after: afterStart,
      })?.toISOString(),
    ).toBe("2026-03-08T07:30:00.000Z");
  });

  it("indexes a provider split counting the shifted gap occurrence", () => {
    const atGap = buildRecurrenceSplitPlan({
      recurrence: [COUNT_RULE],
      seriesStartAt: START,
      targetStartAt: new Date("2026-03-08T07:30:00.000Z"),
      timeZone: ZONE,
    });
    expect(atGap.targetOccurrenceIndex).toBe(1);
    expect(atGap.truncatedRecurrence).toEqual(["RRULE:FREQ=DAILY;COUNT=1"]);
    expect(atGap.followingRecurrence).toEqual(["RRULE:FREQ=DAILY;COUNT=4"]);

    const afterGap = buildRecurrenceSplitPlan({
      recurrence: [COUNT_RULE],
      seriesStartAt: START,
      targetStartAt: new Date("2026-03-09T06:30:00.000Z"),
      timeZone: ZONE,
    });
    expect(afterGap.targetOccurrenceIndex).toBe(2);
    expect(afterGap.truncatedRecurrence).toEqual(["RRULE:FREQ=DAILY;COUNT=2"]);
    expect(afterGap.followingRecurrence).toEqual(["RRULE:FREQ=DAILY;COUNT=3"]);
  });
});
