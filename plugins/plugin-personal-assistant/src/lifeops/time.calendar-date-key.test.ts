/**
 * Pins the calendar-day round trip in `parseLocalDateKey`: a `YYYY-MM-DD`
 * string is accepted only when it names a real day, so impossible dates that
 * `Date.UTC` would silently roll forward are rejected. Deterministic, no I/O.
 */
import { describe, expect, it } from "vitest";
import { getLocalDateKey, parseLocalDateKey } from "./time.js";

describe("parseLocalDateKey", () => {
  it("returns the parts of a real calendar day", () => {
    expect(parseLocalDateKey("2026-02-28")).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(parseLocalDateKey("2024-02-29")).toEqual({
      year: 2024,
      month: 2,
      day: 29,
    });
    const parts = parseLocalDateKey("2026-12-31");
    expect(parts).not.toBeNull();
    expect(getLocalDateKey(parts ?? { year: 0, month: 0, day: 0 })).toBe(
      "2026-12-31",
    );
  });

  it.each(["2026-02-29", "2026-02-30", "2026-04-31", "2026-06-31"])(
    "rejects a day that Date.UTC would roll into the next month: %s",
    (value) => {
      expect(Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))).toBe(true);
      expect(parseLocalDateKey(value)).toBeNull();
    },
  );

  it.each([
    "2026-00-10",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "2026-1-5",
    "20260105",
    "2026-01-05T00:00:00Z",
    " 2026-01-05",
    "yesterday",
    "",
  ])("rejects a string that is not a YYYY-MM-DD calendar day: %j", (value) => {
    expect(parseLocalDateKey(value)).toBeNull();
  });
});
