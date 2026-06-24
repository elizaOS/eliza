// Coverage for the pure task-coordinator display formatters. These are
// presentation-only (no business math) but are shared across the orchestrator
// views, so their formatting contracts are pinned here. Locale is passed
// explicitly and the clock is frozen so the Intl-backed assertions are stable.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatClockTime,
  formatCompactNumber,
  formatDuration,
  formatIsoRelative,
  formatRelativeTime,
  formatUsd,
  stripAnsi,
} from "./view-format";

// ESC (0x1b) built from its char code so the source carries no raw control byte.
const ESC = String.fromCharCode(27);

afterEach(() => {
  vi.useRealTimers();
});

describe("stripAnsi", () => {
  it("removes ANSI escape sequences and trims", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m  `)).toBe("red");
    expect(stripAnsi("  plain  ")).toBe("plain");
  });
});

describe("formatDuration", () => {
  it("renders ms / seconds / minutes with the right precision", () => {
    expect(formatDuration(420)).toBe("420ms");
    expect(formatDuration(4100)).toBe("4.1s"); // < 10s keeps one decimal
    expect(formatDuration(45000)).toBe("45s"); // >= 10s drops the decimal
    expect(formatDuration(150000)).toBe("2m 30s");
    expect(formatDuration(120000)).toBe("2m"); // exact minutes drop the seconds
  });
});

describe("formatCompactNumber / formatUsd", () => {
  it("compacts large counts", () => {
    expect(formatCompactNumber(12300, "en-US")).toBe("12.3K");
    expect(formatCompactNumber(1200000, "en-US")).toBe("1.2M");
  });

  it("formats USD with extra precision below a dollar", () => {
    expect(formatUsd(1.5, "en-US")).toBe("$1.50");
    expect(formatUsd(0, "en-US")).toBe("$0.00");
    expect(formatUsd(0.0051, "en-US")).toBe("$0.0051");
  });
});

describe("formatRelativeTime / formatIsoRelative", () => {
  it("renders relative phrases against a frozen clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const now = Date.now();
    expect(formatRelativeTime(now, "en-US")).toMatch(/now/i);
    expect(formatRelativeTime(now - 5 * 60_000, "en-US")).toMatch(
      /5 minutes? ago/,
    );
    expect(formatRelativeTime(now - 3 * 3_600_000, "en-US")).toMatch(
      /3 hours? ago/,
    );
  });

  it("falls back when the iso value is missing or unparseable", () => {
    expect(formatIsoRelative(null, "en-US", "—")).toBe("—");
    expect(formatIsoRelative("not-a-date", "en-US", "—")).toBe("—");
  });
});

describe("formatClockTime", () => {
  it("renders an HH:MM clock string", () => {
    // Timezone-agnostic shape check (the exact hour depends on the host TZ).
    expect(
      formatClockTime(Date.parse("2026-01-01T08:30:00Z"), "en-US"),
    ).toMatch(/\d{1,2}:\d{2}/);
  });
});
