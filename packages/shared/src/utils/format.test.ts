/**
 * Shared display formatters render dashboard values with stable unit boundaries,
 * precision, timestamp validation, and unavailable-state handling.
 */
import { describe, expect, it, vi } from "vitest";
import {
  formatByteSize,
  formatDateTime,
  formatDurationMs,
  formatShortDate,
  formatTime,
  formatUptime,
  formatUsd,
} from "./format";

const DATE_FORMATTERS = [
  ["date and time", formatDateTime],
  ["time", formatTime],
  ["short date", formatShortDate],
] as const;

describe("formatUptime", () => {
  it("renders compact units and handles invalid input", () => {
    expect(formatUptime(undefined)).toBe("—");
    expect(formatUptime(-1)).toBe("—");
    expect(formatUptime(30)).toBe("30s");
    expect(formatUptime(90)).toBe("1m");
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(90000)).toBe("1d 1h");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back for non-finite uptime %s",
    (seconds) => {
      expect(formatUptime(seconds)).toBe("—");
    },
  );

  it("verbose mode lists each non-zero unit", () => {
    expect(formatUptime(3661, true)).toBe("1h 1m");
    expect(formatUptime(30, true)).toBe("30s");
    expect(formatUptime(90061, true)).toBe("1d 1h 1m");
  });
});

describe("formatByteSize", () => {
  it("scales bytes through B/KB/MB/GB/TB", () => {
    expect(formatByteSize(null)).toBe("unknown");
    expect(formatByteSize(-5)).toBe("unknown");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1536)).toBe("1.5 KB");
    expect(formatByteSize(1024 ** 2)).toBe("1.0 MB");
    expect(formatByteSize(1024 ** 3)).toBe("1.0 GB");
    expect(formatByteSize(1024 ** 4)).toBe("1.0 TB");
    expect(formatByteSize(1536, { precision: 2 })).toBe("1.50 KB");
  });

  it("promotes a value that rounds across a unit boundary instead of rendering an impossible magnitude", () => {
    // 1024**2 - 1 bytes is 1023.999… KB; toFixed used to render "1024.0 KB",
    // a magnitude the KB unit can never legitimately display.
    expect(formatByteSize(1024 ** 2 - 1)).toBe("1.0 MB");
    expect(formatByteSize(1024 ** 3 - 1)).toBe("1.0 GB");
    expect(formatByteSize(1024 ** 4 - 1)).toBe("1.0 TB");
    expect(formatByteSize(1024 ** 2 - 1, { precision: 2 })).toBe("1.00 MB");
  });

  it("keeps values that round below the boundary in their own unit", () => {
    // 1023.94 KB rounds to "1023.9 KB" — no promotion.
    expect(formatByteSize(Math.floor(1023.94 * 1024))).toBe("1023.9 KB");
    // At precision 0 the KB threshold for promotion is 1023.5 KB.
    expect(formatByteSize(1023 * 1024, { precision: 0 })).toBe("1023 KB");
  });

  it("lets TB display 1024 and above because there is no larger unit", () => {
    expect(formatByteSize(1024 ** 5)).toBe("1024.0 TB");
  });
});

describe("formatDurationMs", () => {
  it("renders compact units and handles invalid input", () => {
    expect(formatDurationMs(undefined)).toBe("—");
    expect(formatDurationMs(-1)).toBe("—");
    expect(formatDurationMs(Number.NaN)).toBe("—");
    expect(formatDurationMs(0)).toBe("0s");
    expect(formatDurationMs(30_000)).toBe("30s");
    expect(formatDurationMs(90_000)).toBe("2m");
    expect(formatDurationMs(7_200_000)).toBe("2h");
    expect(formatDurationMs(5_400_000)).toBe("1.5h");
    expect(formatDurationMs(172_800_000)).toBe("2d");
  });

  it("rolls values that round up to a unit boundary into the next unit", () => {
    // 59.5s rounds to 60 → must display as minutes, never "60s".
    expect(formatDurationMs(59_500)).toBe("1m");
    expect(formatDurationMs(59_400)).toBe("59s");
    // 59.983m rounds to 60 → must display as hours, never "60m".
    expect(formatDurationMs(3_599_000)).toBe("1h");
    expect(formatDurationMs(3_540_000)).toBe("59m");
    // 23.99h renders as 24.0 after toFixed(1) → must display as days, never "24h".
    expect(formatDurationMs(86_399_000)).toBe("1d");
    expect(formatDurationMs(85_000_000)).toBe("23.6h");
  });

  it("passes the rolled-over value to the translator", () => {
    const t = (key: string, vars?: Record<string, string | number>) =>
      `${key}:${vars?.value}`;
    expect(formatDurationMs(59_500, { t })).toBe("format.duration.minutes:1");
    expect(formatDurationMs(30_000, { t })).toBe("format.duration.seconds:30");
  });
});

describe("formatUsd", () => {
  it("renders grouped USD, accepts numeric strings, falls back on junk", () => {
    expect(formatUsd(1234.56)).toBe("$1,234.56");
    expect(formatUsd("1234.5")).toBe("$1,234.50");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd("abc")).toBe("—");
    expect(formatUsd(undefined, { fallback: "n/a" })).toBe("n/a");
  });
});

describe("formatTime", () => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "not-a-date"],
    ["numeric NaN", Number.NaN],
    ["invalid Date", new Date(Number.NaN)],
    ["outside TimeClip", 8.64e15 + 1],
    ["calendar-invalid ISO timestamp", "2026-02-31T00:00:00Z"],
    ["non-leap February 29", "2026-02-29T00:00:00Z"],
    ["month zero", "2026-00-01T00:00:00Z"],
  ])("returns the fallback for %s input", (_label, value) => {
    expect(
      formatTime(value, { fallback: "Unavailable", locale: "en-US" }),
    ).toBe("Unavailable");
  });

  it("preserves valid epoch, Date, ISO, leap-day, and parseable string inputs", () => {
    const localeSpy = vi
      .spyOn(Date.prototype, "toLocaleTimeString")
      .mockReturnValue("12:34:56 PM");

    expect(formatTime(0, { locale: "en-US" })).toBe("12:34:56 PM");
    expect(formatTime(new Date(0), { locale: "en-US" })).toBe("12:34:56 PM");
    expect(formatTime("2026-06-05T10:00:00Z", { locale: "en-US" })).toBe(
      "12:34:56 PM",
    );
    expect(formatTime("2024-02-29T00:00:00Z", { locale: "en-US" })).toBe(
      "12:34:56 PM",
    );
    expect(formatTime("June 5, 2026 10:00:00", { locale: "en-US" })).toBe(
      "12:34:56 PM",
    );
    expect(localeSpy).toHaveBeenCalledTimes(5);
  });
});

describe.each(DATE_FORMATTERS)("formatting %s", (_label, formatter) => {
  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["malformed", "not-a-date"],
    ["numeric NaN", Number.NaN],
    ["invalid Date", new Date(Number.NaN)],
    ["outside TimeClip", 8.64e15 + 1],
    ["calendar-invalid ISO timestamp", "2026-02-31T00:00:00Z"],
    ["non-leap February 29", "2026-02-29"],
    ["month zero", "2026-00-01"],
    ["month thirteen", "2026-13-01"],
    ["day zero", "2026-01-00"],
    ["thirty-first day in April", "2026-04-31"],
  ])("returns the configured fallback for %s input", (_case, value) => {
    expect(formatter(value, { fallback: "Unavailable", locale: "en-US" })).toBe(
      "Unavailable",
    );
  });
});

describe("date display formatter compatibility", () => {
  it("preserves supported date-and-time input shapes", () => {
    const localeSpy = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockReturnValue("June 5, 2026 at 10:00 AM");

    for (const value of [
      0,
      new Date(0),
      "2026-06-05T10:00:00Z",
      "2024-02-29T00:00:00Z",
      "June 5, 2026 10:00:00",
    ]) {
      expect(formatDateTime(value, { locale: "en-US" })).toBe(
        "June 5, 2026 at 10:00 AM",
      );
    }
    expect(localeSpy).toHaveBeenCalledTimes(5);
  });

  it("preserves supported short-date input shapes", () => {
    const localeSpy = vi
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("Jun 5, 2026");

    for (const value of [
      0,
      new Date(0),
      "2026-06-05T10:00:00Z",
      "2024-02-29",
      "June 5, 2026 10:00:00",
    ]) {
      expect(formatShortDate(value, { locale: "en-US" })).toBe("Jun 5, 2026");
    }
    expect(localeSpy).toHaveBeenCalledTimes(5);
  });
});
