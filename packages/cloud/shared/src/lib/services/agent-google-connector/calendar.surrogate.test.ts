/**
 * Regression for #24990: validates reachable invalid-timestamp handling
 * without coercing NaN to epoch-zero sort key.
 */
import { describe, expect, test } from "bun:test";
import { buildUtcDateFromLocalParts } from "./calendar";

describe("buildUtcDateFromLocalParts NaN handling (#24990)", () => {
  test("rejects non-finite baseUtcMs at boundary (fails closed, not epoch-zero)", () => {
    const parts = { year: Number.NaN, month: 1, day: 1, hour: 0, minute: 0, second: 0 } as any;
    expect(() => buildUtcDateFromLocalParts("UTC", parts)).toThrow(RangeError);
    try {
      buildUtcDateFromLocalParts("UTC", parts);
    } catch (e) {
      expect((e as Error).message).toContain("cannot be resolved");
      expect(Number.isFinite((e as RangeError).message.length)).toBe(true);
    }
  });

  test("filters invalid candidates and does not select epoch-zero for non-finite", () => {
    expect(() =>
      buildUtcDateFromLocalParts("UTC", {
        year: NaN,
        month: NaN,
        day: NaN,
        hour: NaN,
        minute: NaN,
        second: NaN,
      } as any),
    ).toThrow(RangeError);
  });

  test("existing valid disambiguation still chooses earliest repeat and skips correctly", () => {
    const repeated = buildUtcDateFromLocalParts("America/New_York", {
      year: 2026,
      month: 11,
      day: 1,
      hour: 1,
      minute: 30,
      second: 0,
    });
    const skipped = buildUtcDateFromLocalParts("America/New_York", {
      year: 2026,
      month: 3,
      day: 8,
      hour: 2,
      minute: 30,
      second: 0,
    });
    expect(repeated.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(skipped.toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });
});
