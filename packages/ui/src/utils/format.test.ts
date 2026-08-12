/**
 * Unit tests for the relative-time formatters. Deterministic: the clock is
 * frozen with fake timers so exact thresholds and ±1ms boundaries can be
 * asserted without slack. Past magnitudes floor (legacy output unchanged);
 * future magnitudes ceil, so "in N <unit>" names the minimal N such that the
 * moment arrives within N units. The translator path runs through the real
 * `createTranslator("en")` so the `conversations.in*` keys are proven to
 * resolve from the bundled English catalog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "../i18n";
import { formatRelativeTime, formatRelativeTimeShort } from "./format";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 2026-01-15T12:00:00.000Z — an arbitrary fixed instant.
const NOW = 1768478400000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTimeShort", () => {
  it("renders sub-minute offsets as 'now' in both directions", () => {
    expect(formatRelativeTimeShort(NOW)).toBe("now");
    expect(formatRelativeTimeShort(NOW - MINUTE + 1)).toBe("now");
    expect(formatRelativeTimeShort(NOW + MINUTE - 1)).toBe("now");
  });

  it("floors past magnitudes (legacy output unchanged)", () => {
    expect(formatRelativeTimeShort(NOW - MINUTE)).toBe("1m");
    expect(formatRelativeTimeShort(NOW - 5 * MINUTE - 1)).toBe("5m");
    expect(formatRelativeTimeShort(NOW - HOUR)).toBe("1h");
    expect(formatRelativeTimeShort(NOW - DAY)).toBe("1d");
    expect(formatRelativeTimeShort(NOW - 3 * DAY - HOUR)).toBe("3d");
  });

  it("ceils future magnitudes and prefixes 'in' instead of collapsing to 'now'", () => {
    // The motivating defect: a signed diff made every future timestamp
    // negative-minutes, so `< 1` rendered it "now" indefinitely.
    expect(formatRelativeTimeShort(NOW + 5 * MINUTE)).toBe("in 5m");
    expect(formatRelativeTimeShort(NOW + 5 * MINUTE - 1)).toBe("in 5m");
    expect(formatRelativeTimeShort(NOW + HOUR - 1)).toBe("in 1h");
    expect(formatRelativeTimeShort(NOW + HOUR)).toBe("in 1h");
    expect(formatRelativeTimeShort(NOW + DAY - 1)).toBe("in 1d");
    expect(formatRelativeTimeShort(NOW + 3 * DAY)).toBe("in 3d");
  });

  it("rounds a future moment just past a boundary up to the next unit", () => {
    // "in N <unit>" promises arrival within N units, so 60s+1ms cannot claim
    // "in 1m" — the minimal true N is 2. Same rule at each unit scale.
    expect(formatRelativeTimeShort(NOW + MINUTE + 1)).toBe("in 2m");
    expect(formatRelativeTimeShort(NOW + HOUR + 1)).toBe("in 2h");
    expect(formatRelativeTimeShort(NOW + DAY + 1)).toBe("in 2d");
  });

  it("falls back to a locale date at a week and beyond in both directions", () => {
    expect(formatRelativeTimeShort(NOW - 8 * DAY)).not.toMatch(
      /^\d+[mhd]$|now/,
    );
    expect(formatRelativeTimeShort(NOW + 8 * DAY)).not.toMatch(/in |now/);
  });

  it("renders an unparseable value as 'now'", () => {
    expect(formatRelativeTimeShort("not a date")).toBe("now");
  });
});

describe("formatRelativeTime (English defaults)", () => {
  it("renders sub-minute offsets as 'just now' in both directions", () => {
    expect(formatRelativeTime(NOW - MINUTE + 1)).toBe("just now");
    expect(formatRelativeTime(NOW + MINUTE - 1)).toBe("just now");
  });

  it("floors past magnitudes and suffixes 'ago' (legacy output unchanged)", () => {
    expect(formatRelativeTime(NOW - MINUTE)).toBe("1m ago");
    expect(formatRelativeTime(NOW - 5 * MINUTE - 1)).toBe("5m ago");
    expect(formatRelativeTime(NOW - HOUR)).toBe("1h ago");
    expect(formatRelativeTime(NOW - DAY)).toBe("1d ago");
  });

  it("ceils future magnitudes and prefixes 'in'", () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE)).toBe("in 5m");
    expect(formatRelativeTime(NOW + 5 * MINUTE - 1)).toBe("in 5m");
    expect(formatRelativeTime(NOW + HOUR)).toBe("in 1h");
    expect(formatRelativeTime(NOW + DAY)).toBe("in 1d");
    expect(formatRelativeTime(NOW + MINUTE + 1)).toBe("in 2m");
  });

  it("accepts ISO strings and Date instances", () => {
    expect(formatRelativeTime(new Date(NOW + 5 * MINUTE))).toBe("in 5m");
    expect(formatRelativeTime(new Date(NOW - 5 * MINUTE).toISOString())).toBe(
      "5m ago",
    );
  });
});

describe("formatRelativeTime (translated)", () => {
  const t = createTranslator("en");

  it("resolves the conversations.in* keys from the English catalog", () => {
    expect(formatRelativeTime(NOW + 5 * MINUTE, t)).toBe("in 5m");
    expect(formatRelativeTime(NOW + 2 * HOUR, t)).toBe("in 2h");
    expect(formatRelativeTime(NOW + 3 * DAY, t)).toBe("in 3d");
  });

  it("keeps resolving the past-direction keys", () => {
    expect(formatRelativeTime(NOW - 5 * MINUTE, t)).toBe("5m ago");
    expect(formatRelativeTime(NOW - 2 * HOUR, t)).toBe("2h ago");
    expect(formatRelativeTime(NOW - MINUTE + 1, t)).toBe("just now");
  });
});
