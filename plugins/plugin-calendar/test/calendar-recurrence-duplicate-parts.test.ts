/**
 * Duplicate RRULE parts are rejected: RFC 5545 §3.3.10 states a rule part
 * must not occur more than once. The parser used to keep the last value
 * silently, so a duplicated FREQ or INTERVAL changed the series without any
 * error — while the split path already rejected the same input as lossy.
 */

import { describe, expect, it } from "vitest";
import { CalendarServiceError } from "../src/internal/errors.js";
import {
  normalizeRecurrence,
  parseRecurrenceRule,
} from "../src/internal/recurrence.js";

describe("duplicate RRULE parts are rejected", () => {
  it.each([
    "RRULE:FREQ=DAILY;FREQ=WEEKLY",
    "RRULE:FREQ=DAILY;INTERVAL=2;INTERVAL=3",
    "RRULE:FREQ=DAILY;COUNT=5;COUNT=10",
    "RRULE:FREQ=DAILY;BYDAY=MO;BYDAY=TU",
    "RRULE:FREQ=DAILY;UNTIL=20261215;UNTIL=20270101",
    "RRULE:FREQ=DAILY;WKST=MO;WKST=SU",
    "RRULE:FREQ=DAILY;freq=WEEKLY",
  ])("rejects %s", (rule) => {
    expect(() => parseRecurrenceRule(rule)).toThrow(CalendarServiceError);
    try {
      parseRecurrenceRule(rule);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarServiceError);
      expect((error as CalendarServiceError).status).toBe(400);
      expect((error as CalendarServiceError).code).toBe(
        "CALENDAR_INVALID_RECURRENCE",
      );
      expect((error as Error).message).toMatch(/duplicate/i);
    }
  });

  it("rejects a duplicated part on the provider-bound normalize path", () => {
    expect(() => normalizeRecurrence(["RRULE:FREQ=DAILY;FREQ=WEEKLY"])).toThrow(
      /duplicate/i,
    );
  });

  it("still accepts a rule with each part once", () => {
    const rule = parseRecurrenceRule(
      "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=5",
    );
    expect(rule.freq).toBe("WEEKLY");
    expect(rule.interval).toBe(2);
    expect(rule.byDay).toEqual([1, 3]);
    expect(rule.count).toBe(5);
  });
});
