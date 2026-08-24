/**
 * Pins the canonical scheduling resolver's compatible handling of repeated
 * clocks, skipped hours, and a skipped calendar date.
 */
import { describe, expect, it } from "vitest";
import { resolveLocalHHMMToIso } from "./local-time.js";

describe("resolveLocalHHMMToIso compatible disambiguation", () => {
  it("moves Santiago's skipped midnight forward by the one-hour gap", () => {
    expect(
      resolveLocalHHMMToIso(
        new Date("2026-09-06T16:00:00.000Z"),
        "00:00",
        "America/Santiago",
      ),
    ).toBe("2026-09-06T04:00:00.000Z");
  });

  it("moves Apia's skipped next date forward by the 24-hour gap", () => {
    expect(
      resolveLocalHHMMToIso(
        new Date("2011-12-29T22:00:00.000Z"),
        "00:00",
        "Pacific/Apia",
        1,
      ),
    ).toBe("2011-12-30T10:00:00.000Z");
  });

  it("chooses the earlier repeated New York time", () => {
    expect(
      resolveLocalHHMMToIso(
        new Date("2026-11-01T17:00:00.000Z"),
        "01:30",
        "America/New_York",
      ),
    ).toBe("2026-11-01T05:30:00.000Z");
  });

  it("moves a skipped New York time forward by the gap", () => {
    expect(
      resolveLocalHHMMToIso(
        new Date("2026-03-08T16:00:00.000Z"),
        "02:30",
        "America/New_York",
      ),
    ).toBe("2026-03-08T07:30:00.000Z");
  });
});

describe("resolveLocalHHMMToIso year 0-99 handling", () => {
  function utcDateForYear(year: number, month: number, day: number): Date {
    const d = new Date(0);
    d.setUTCFullYear(year, month - 1, day);
    d.setUTCHours(12, 0, 0, 0);
    return d;
  }

  it("keeps year 0 from becoming 1900 (Intl maps 0000 to 0001)", () => {
    const now = utcDateForYear(0, 1, 1);
    const iso = resolveLocalHHMMToIso(now, "12:00", "UTC", 0);
    // Intl.DateTimeFormat for UTC maps year 0 (1 BC) to 1, so 0000 becomes 0001;
    // the critical fix is it must not become 1900 via Date.UTC 0-99 bug.
    expect(iso).toBe("0001-01-01T12:00:00.000Z");
  });

  it("keeps year 5 correctly", () => {
    const now = utcDateForYear(5, 6, 15);
    const iso = resolveLocalHHMMToIso(now, "09:30", "UTC", 0);
    expect(iso).toBe("0005-06-15T09:30:00.000Z");
  });

  it("keeps year 99 as 0099 not 1999", () => {
    const now = utcDateForYear(99, 12, 31);
    const iso = resolveLocalHHMMToIso(now, "23:59", "UTC", 0);
    expect(iso).toBe("0099-12-31T23:59:00.000Z");
  });

  it("addLocalDays rolls year 0 correctly via dayOffset (Intl maps 0000 to 0001)", () => {
    const jan1 = utcDateForYear(0, 1, 1);
    const jan2Iso = resolveLocalHHMMToIso(jan1, "12:00", "UTC", 1);
    expect(jan2Iso).toBe("0001-01-02T12:00:00.000Z");
  });
});
