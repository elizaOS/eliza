/**
 * Behavioral regression for Date.UTC years 0-99. `Date.UTC(10, …)` is 1910;
 * `setUTCFullYear(10, …)` is year 10. These cases call the real production
 * parsers that previously used Date.UTC, so they fail if the fix is reverted.
 */

import { describe, expect, it } from "vitest";
import { parseRecurrenceRule } from "./recurrence.js";

describe("parseRecurrenceRule UNTIL years 0-99", () => {
  it("date-only UNTIL=00100201 is year 10, not 1910", () => {
    const rule = parseRecurrenceRule("FREQ=DAILY;UNTIL=00100201");
    expect(rule.untilMs).toBeDefined();
    const until = new Date(rule.untilMs ?? Number.NaN);
    expect(until.getUTCFullYear()).toBe(10);
    expect(until.getUTCMonth()).toBe(1);
    expect(until.getUTCDate()).toBe(1);
    expect(until.getUTCHours()).toBe(23);
    expect(until.getUTCMinutes()).toBe(59);
    expect(until.getUTCSeconds()).toBe(59);
    expect(new Date(Date.UTC(10, 1, 1, 23, 59, 59)).getUTCFullYear()).toBe(
      1910,
    );
  });

  it("date-time UNTIL=00000101T120000Z is year 0, not 1900", () => {
    const rule = parseRecurrenceRule("FREQ=DAILY;UNTIL=00000101T120000Z");
    const until = new Date(rule.untilMs ?? Number.NaN);
    expect(until.getUTCFullYear()).toBe(0);
    expect(until.getUTCHours()).toBe(12);
    expect(new Date(Date.UTC(0, 0, 1, 12, 0, 0)).getUTCFullYear()).toBe(1900);
  });

  it("UNTIL=00991231 stays year 99", () => {
    const until = new Date(
      parseRecurrenceRule("FREQ=YEARLY;UNTIL=00991231").untilMs ?? Number.NaN,
    );
    expect(until.getUTCFullYear()).toBe(99);
    expect(until.getUTCMonth()).toBe(11);
    expect(until.getUTCDate()).toBe(31);
  });

  it("UNTIL years >= 100 still parse as the declared year", () => {
    const until = new Date(
      parseRecurrenceRule("FREQ=DAILY;UNTIL=20240531T000000Z").untilMs ??
        Number.NaN,
    );
    expect(until.toISOString()).toBe("2024-05-31T00:00:00.000Z");
  });
});




