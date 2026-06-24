import { describe, expect, it } from "vitest";
import { formatByteSize, formatUptime, formatUsd } from "./format";

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

describe("formatUsd", () => {
  it("renders grouped USD, accepts numeric strings, falls back on junk", () => {
    expect(formatUsd(1234.56)).toBe("$1,234.56");
    expect(formatUsd("1234.5")).toBe("$1,234.50");
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd("abc")).toBe("—");
    expect(formatUsd(undefined, { fallback: "n/a" })).toBe("n/a");
  });
});
