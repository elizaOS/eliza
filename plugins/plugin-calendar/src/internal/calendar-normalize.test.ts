import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fail: vi.fn((status: number, message: string) => {
    throw new Error(`CalendarServiceError(${status}): ${message}`);
  }),
  requireNonEmptyString: (v: unknown, f: string) => String(v),
  normalizeIsoString: (v: string) => v,
  buildUtcDateFromLocalParts: (_tz: string, parts: Record<string, number>) => {
    const d = new Date(
      Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        parts.second,
      ),
    );
    return d;
  },
  normalizeValidTimeZone: (v: unknown) => v ?? "UTC",
  resolveDefaultTimeZone: () => "UTC",
  normalizeOptionalString: (v: unknown) => (v == null ? undefined : String(v)),
  addDaysToLocalDate: (d: Date, n: number) => {
    const x = new Date(d);
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  },
  addMinutes: (d: Date, n: number) => new Date(d.getTime() + n * 60_000),
  getZonedDateParts: (_tz: string, d: Date) => ({
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  }),
  normalizeGoogleCapabilities: (v: unknown) => v,
  normalizeOptionalBoolean: (v: unknown) => v,
  normalizeOptionalMinutes: (v: unknown) => v,
  normalizeOptionalIsoString: (v: unknown) => v,
}));

vi.mock("@elizaos/shared", () => ({
  LIFEOPS_CALENDAR_WINDOW_PRESETS: {},
}));
vi.mock("./constants.js", () => ({
  DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS: 7,
  GOOGLE_GMAIL_READ_SCOPE: "scope",
  GOOGLE_PRIMARY_CALENDAR_ID: "primary",
  resolveDefaultTimeZone: () => "UTC",
}));
vi.mock("./errors.js", () => ({ fail: mocks.fail }));
vi.mock("./normalize.js", () => ({
  normalizeGoogleCapabilities: mocks.normalizeGoogleCapabilities,
  normalizeIsoString: mocks.normalizeIsoString,
  normalizeOptionalBoolean: mocks.normalizeOptionalBoolean,
  normalizeOptionalIsoString: mocks.normalizeOptionalIsoString,
  normalizeOptionalMinutes: mocks.normalizeOptionalMinutes,
  normalizeOptionalString: mocks.normalizeOptionalString,
  normalizeValidTimeZone: mocks.normalizeValidTimeZone,
  requireNonEmptyString: mocks.requireNonEmptyString,
}));
vi.mock("./time.js", () => ({
  addDaysToLocalDate: mocks.addDaysToLocalDate,
  addMinutes: mocks.addMinutes,
  buildUtcDateFromLocalParts: mocks.buildUtcDateFromLocalParts,
  getZonedDateParts: mocks.getZonedDateParts,
}));

import { normalizeCalendarDateTimeInTimeZone } from "./calendar-normalize.ts";

const UTC = "UTC";

describe("normalizeCalendarDateTimeInTimeZone (time-of-day range)", () => {
  it("normalizes a valid local datetime", () => {
    const result = normalizeCalendarDateTimeInTimeZone(
      "2026-08-24T14:30:00",
      "start",
      UTC,
    );
    expect(result).toBe("2026-08-24T14:30:00.000Z");
  });

  it("rejects an out-of-range hour with CalendarServiceError (not RangeError)", () => {
    expect(() =>
      normalizeCalendarDateTimeInTimeZone("2026-08-24T25:00:00", "start", UTC),
    ).toThrow(/valid ISO datetime/);
  });

  it("rejects out-of-range minutes and seconds", () => {
    expect(() =>
      normalizeCalendarDateTimeInTimeZone("2026-08-24T12:99:00", "start", UTC),
    ).toThrow(/valid ISO datetime/);
    expect(() =>
      normalizeCalendarDateTimeInTimeZone("2026-08-24T12:30:99", "start", UTC),
    ).toThrow(/valid ISO datetime/);
  });

  it("still rejects impossible civil dates", () => {
    expect(() =>
      normalizeCalendarDateTimeInTimeZone("2026-02-30T10:00:00", "start", UTC),
    ).toThrow(/valid ISO datetime/);
  });

  it("accepts boundary values", () => {
    expect(
      normalizeCalendarDateTimeInTimeZone("2026-08-24T23:59:59", "start", UTC),
    ).toBe("2026-08-24T23:59:59.000Z");
  });
});
