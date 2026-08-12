import { describe, expect, it } from "vitest";
import {
  formatTrajectoryDuration,
  formatTrajectoryTimestamp,
  formatTrajectoryTokenCount,
} from "./trajectory-format";

const EMPTY = { emptyLabel: "—" };

describe("formatTrajectoryDuration", () => {
  it("formats null as the placeholder", () => {
    expect(formatTrajectoryDuration(null)).toBe("—");
  });

  it("fails closed on non-finite values", () => {
    expect(formatTrajectoryDuration(Number.NaN)).toBe("—");
    expect(formatTrajectoryDuration(Number.POSITIVE_INFINITY)).toBe("—");
    expect(formatTrajectoryDuration(Number.NEGATIVE_INFINITY)).toBe("—");
  });

  it("fails closed on negative durations while preserving 0ms", () => {
    // Negative integer / fractional durations are impossible trajectory
    // durations and fall in the same corrupt-input class. formatDurationMs
    // in format.ts rejects ms < 0; this helper now does too.
    expect(formatTrajectoryDuration(-1)).toBe("—");
    expect(formatTrajectoryDuration(-0.5)).toBe("—");
    expect(formatTrajectoryDuration(-1000)).toBe("—");
    // 0ms is a valid zero-length duration and must still render, not "—".
    expect(formatTrajectoryDuration(0)).toBe("0ms");
  });

  it("formats sub-second durations in ms", () => {
    expect(formatTrajectoryDuration(0)).toBe("0ms");
    expect(formatTrajectoryDuration(999)).toBe("999ms");
  });

  it("formats seconds with one decimal", () => {
    expect(formatTrajectoryDuration(1000)).toBe("1.0s");
    expect(formatTrajectoryDuration(1250)).toBe("1.3s");
    expect(formatTrajectoryDuration(59_400)).toBe("59.4s");
  });

  it("rolls over to minutes when rounding crosses the 60s boundary", () => {
    // 59.94s rounds to 59.9s — stays in seconds
    expect(formatTrajectoryDuration(59_940)).toBe("59.9s");
    // 59.95s rounds to 60.0s — must roll over, "60.0s" is impossible
    expect(formatTrajectoryDuration(59_950)).toBe("1.0m");
    expect(formatTrajectoryDuration(59_999)).toBe("1.0m");
  });

  it("formats minutes with one decimal", () => {
    expect(formatTrajectoryDuration(60_000)).toBe("1.0m");
    expect(formatTrajectoryDuration(65_000)).toBe("1.1m");
    expect(formatTrajectoryDuration(3_594_000)).toBe("59.9m");
  });

  it("rolls over to hours when rounding crosses the 60m boundary", () => {
    // 59.95m rounds to 60.0m — must roll over, "60.0m" is impossible
    expect(formatTrajectoryDuration(3_597_000)).toBe("1.0h");
    expect(formatTrajectoryDuration(3_599_999)).toBe("1.0h");
  });

  it("formats hours with one decimal", () => {
    expect(formatTrajectoryDuration(7_200_000)).toBe("2.0h");
    expect(formatTrajectoryDuration(86_400_000)).toBe("24.0h");
  });
});

describe("formatTrajectoryTokenCount", () => {
  it("returns the empty label for undefined or zero", () => {
    expect(formatTrajectoryTokenCount(undefined, EMPTY)).toBe("—");
    expect(formatTrajectoryTokenCount(0, EMPTY)).toBe("—");
  });

  it("fails closed on non-finite or negative values", () => {
    expect(formatTrajectoryTokenCount(Number.NaN, EMPTY)).toBe("—");
    expect(formatTrajectoryTokenCount(Number.POSITIVE_INFINITY, EMPTY)).toBe(
      "—",
    );
    expect(formatTrajectoryTokenCount(-1, EMPTY)).toBe("—");
    // emptyLabel is honored, not hardcoded to "—"
    expect(formatTrajectoryTokenCount(Number.NaN, { emptyLabel: "n/a" })).toBe(
      "n/a",
    );
  });

  it("formats raw counts below 1000 without a suffix", () => {
    expect(formatTrajectoryTokenCount(1, EMPTY)).toBe("1");
    expect(formatTrajectoryTokenCount(999, EMPTY)).toBe("999");
  });

  it("formats thousands with one decimal", () => {
    expect(formatTrajectoryTokenCount(1_000, EMPTY)).toBe("1.0k");
    expect(formatTrajectoryTokenCount(12_345, EMPTY)).toBe("12.3k");
    expect(formatTrajectoryTokenCount(999_499, EMPTY)).toBe("999.5k");
  });

  it("promotes to M when rounding crosses the 1000k boundary", () => {
    // 999.5k rounds to 1000.0k — must promote, "1000.0k" is impossible
    expect(formatTrajectoryTokenCount(999_500, EMPTY)).toBe("1.0M");
    expect(formatTrajectoryTokenCount(999_950, EMPTY)).toBe("1.0M");
  });

  it("formats millions with one decimal", () => {
    expect(formatTrajectoryTokenCount(1_000_000, EMPTY)).toBe("1.0M");
    expect(formatTrajectoryTokenCount(1_500_000, EMPTY)).toBe("1.5M");
    expect(formatTrajectoryTokenCount(2_345_678, EMPTY)).toBe("2.3M");
  });
});

describe("formatTrajectoryTimestamp", () => {
  it("fails closed on empty or unparseable timestamps", () => {
    expect(formatTrajectoryTimestamp("", "smart")).toBe("—");
    expect(formatTrajectoryTimestamp("", "detailed")).toBe("—");
    expect(formatTrajectoryTimestamp("not-a-date", "smart")).toBe("—");
    expect(formatTrajectoryTimestamp("not-a-date", "detailed")).toBe("—");
  });

  it("formats today in smart mode as a local time", () => {
    const date = new Date();
    const out = formatTrajectoryTimestamp(date.toISOString(), "smart");
    expect(out).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it("formats non-today dates with a short month and day", () => {
    const date = new Date(Date.now() - 3 * 86_400_000);
    const out = formatTrajectoryTimestamp(date.toISOString(), "smart");
    const expected = new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
    expect(out).toBe(expected);
  });

  it("formats detailed mode with seconds", () => {
    const date = new Date("2026-08-01T04:05:06Z");
    const out = formatTrajectoryTimestamp(date.toISOString(), "detailed");
    expect(out).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });
});
