// Pure display-formatter tests for src/view-format.ts. These helpers render the
// timestamps, token counts, USD figures, ANSI-stripped stream text, and tool
// durations that the task-coordinator views show; their bucket boundaries and
// precision rules are the contract. We pin the locale to "en-US" so the Intl
// output is deterministic across machines and assert exact strings where the
// format is fixed (compact numbers, USD precision, durations) and shape where
// the wording is locale-driven (relative time).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatClockTime,
  formatCompactNumber,
  formatDuration,
  formatIsoRelative,
  formatRelativeTime,
  formatUsd,
  stripAnsi,
} from "../../src/view-format";

describe("view-format: stripAnsi", () => {
  it("removes CSI color sequences and trims the result", () => {
    expect(stripAnsi("[31mred text[0m")).toBe("red text");
    expect(stripAnsi("[1;32mbold green[0m  ")).toBe("bold green");
  });

  it("removes OSC sequences terminated by BEL", () => {
    expect(stripAnsi("]0;window titlepayload")).toBe("payload");
  });

  it("removes charset-designation escapes", () => {
    expect(stripAnsi("(Bplain")).toBe("plain");
  });

  it("leaves plain text untouched apart from trimming", () => {
    expect(stripAnsi("  hello world  ")).toBe("hello world");
  });
});

describe("view-format: formatRelativeTime", () => {
  const FIXED_NOW = new Date("2026-06-16T12:00:00.000Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders sub-5-second deltas as the present (no '-N')", () => {
    // numeric:auto collapses 0 to a word like "now" — never a negative number.
    const out = formatRelativeTime(FIXED_NOW - 2_000, "en-US");
    expect(out).toMatch(/now/i);
    expect(out).not.toMatch(/-/);
  });

  it("renders a sub-minute delta in the seconds bucket", () => {
    expect(formatRelativeTime(FIXED_NOW - 30_000, "en-US")).toBe(
      "30 seconds ago",
    );
  });

  it("renders a sub-hour delta in the minutes bucket", () => {
    expect(formatRelativeTime(FIXED_NOW - 5 * 60_000, "en-US")).toBe(
      "5 minutes ago",
    );
  });

  it("renders a sub-day delta in the hours bucket", () => {
    expect(formatRelativeTime(FIXED_NOW - 3 * 3_600_000, "en-US")).toBe(
      "3 hours ago",
    );
  });

  it("renders a multi-day delta in the days bucket", () => {
    expect(formatRelativeTime(FIXED_NOW - 2 * 86_400_000, "en-US")).toBe(
      "2 days ago",
    );
  });
});

describe("view-format: formatIsoRelative", () => {
  const FIXED_NOW = new Date("2026-06-16T12:00:00.000Z").getTime();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the fallback for null/undefined input", () => {
    expect(formatIsoRelative(null, "en-US", "never")).toBe("never");
    expect(formatIsoRelative(undefined, "en-US", "never")).toBe("never");
  });

  it("returns the fallback for an unparseable string", () => {
    expect(formatIsoRelative("not-a-date", "en-US", "Unknown")).toBe("Unknown");
  });

  it("renders a valid ISO timestamp as relative time", () => {
    expect(
      formatIsoRelative("2026-06-16T11:55:00.000Z", "en-US", "Unknown"),
    ).toBe("5 minutes ago");
  });
});

describe("view-format: formatClockTime", () => {
  it("renders a two-digit HH:MM clock", () => {
    const ts = new Date("2026-06-16T09:07:00.000Z").getTime();
    // Pin to UTC via the locale's hour cycle by forcing a 24h-ish check: the
    // output must be HH:MM with two-digit fields and a separator.
    const out = formatClockTime(ts, "en-GB");
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("view-format: formatCompactNumber", () => {
  it("compacts thousands to a single decimal K", () => {
    expect(formatCompactNumber(12345, "en-US")).toBe("12.3K");
  });

  it("compacts millions to an M suffix", () => {
    expect(formatCompactNumber(2_400_000, "en-US")).toBe("2.4M");
  });

  it("leaves small numbers as-is", () => {
    expect(formatCompactNumber(42, "en-US")).toBe("42");
  });
});

describe("view-format: formatUsd", () => {
  it("keeps extra precision (up to 4 dp) for a sub-dollar non-zero cost", () => {
    // maximumFractionDigits:4 only lifts the cap; the currency min is 2dp, so a
    // 2dp value stays 2dp but a finer value is preserved instead of rounded to 2.
    expect(formatUsd(0.42, "en-US")).toBe("$0.42");
    expect(formatUsd(0.4256, "en-US")).toBe("$0.4256");
    expect(formatUsd(0.001234, "en-US")).toBe("$0.0012");
  });

  it("caps dollar-and-up amounts at 2 decimals (no sub-dollar precision)", () => {
    expect(formatUsd(12.5, "en-US")).toBe("$12.50");
    expect(formatUsd(1.2345, "en-US")).toBe("$1.23");
  });

  it("renders exactly zero with 2 decimals (the value<1 branch excludes 0)", () => {
    expect(formatUsd(0, "en-US")).toBe("$0.00");
  });
});

describe("view-format: formatDuration", () => {
  it("renders sub-second durations as whole milliseconds", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(999)).toBe("999ms");
  });

  it("renders single-digit seconds with one decimal", () => {
    expect(formatDuration(4100)).toBe("4.1s");
  });

  it("renders two-digit seconds without a decimal", () => {
    expect(formatDuration(12_000)).toBe("12s");
  });

  it("renders minutes-and-seconds for >= 60s", () => {
    expect(formatDuration(150_000)).toBe("2m 30s");
  });

  it("renders a bare minute count when seconds land exactly on the minute", () => {
    expect(formatDuration(120_000)).toBe("2m");
  });
});
