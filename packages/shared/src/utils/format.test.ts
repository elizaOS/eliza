import { describe, expect, it } from "vitest";
import {
  formatByteSize,
  formatDurationMs,
  formatUptime,
  formatUsd,
} from "./format";

/**
 * Shared display formatters (uptime / byte size / USD). These render values in
 * dashboard views; the unit thresholds, precision, and fallback handling are
 * pinned so the displayed figures stay correct and stable.
 */

describe("formatUptime", () => {
  it("renders compact units and handles invalid input", () => {
    expect(formatUptime(undefined)).toBe("—");
    expect(formatUptime(-1)).toBe("—");
    expect(formatUptime(30)).toBe("30s");
    expect(formatUptime(90)).toBe("1m");
    expect(formatUptime(3661)).toBe("1h 1m");
    expect(formatUptime(90000)).toBe("1d 1h");
  });

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
