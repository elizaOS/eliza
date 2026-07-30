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
