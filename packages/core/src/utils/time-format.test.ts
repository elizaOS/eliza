/**
 * Unit tests for the relative-time formatter. Deterministic: the clock is
 * frozen with fake timers so exact thresholds and ±1ms boundaries around 60s,
 * 60m, and 24h can be asserted without slack. Past magnitudes floor (legacy
 * behavior, byte-identical output); future magnitudes ceil, so "in N <unit>"
 * always names the minimal N such that the moment arrives within N units.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime, formatTimestamp } from "./time-format";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
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

describe("formatRelativeTime (compact)", () => {
	it("renders sub-minute offsets as 'just now' in both directions", () => {
		expect(formatRelativeTime(NOW)).toBe("just now");
		expect(formatRelativeTime(NOW - 30 * SECOND)).toBe("just now");
		expect(formatRelativeTime(NOW + 30 * SECOND)).toBe("just now");
		expect(formatRelativeTime(NOW - MINUTE + 1)).toBe("just now");
		expect(formatRelativeTime(NOW + MINUTE - 1)).toBe("just now");
	});

	it("floors past magnitudes and suffixes 'ago' (legacy output unchanged)", () => {
		expect(formatRelativeTime(NOW - MINUTE)).toBe("1m ago");
		expect(formatRelativeTime(NOW - MINUTE - 1)).toBe("1m ago");
		expect(formatRelativeTime(NOW - 5 * MINUTE)).toBe("5m ago");
		expect(formatRelativeTime(NOW - HOUR + 1)).toBe("59m ago");
		expect(formatRelativeTime(NOW - HOUR)).toBe("1h ago");
		expect(formatRelativeTime(NOW - HOUR - 1)).toBe("1h ago");
		expect(formatRelativeTime(NOW - DAY + 1)).toBe("23h ago");
		expect(formatRelativeTime(NOW - DAY)).toBe("Yesterday");
		expect(formatRelativeTime(NOW - DAY - 1)).toBe("Yesterday");
		expect(formatRelativeTime(NOW - 3 * DAY)).toBe("3d ago");
	});

	it("ceils future magnitudes and prefixes 'in'", () => {
		// The motivating defect: a target computed as now + 5 minutes has lost
		// milliseconds by the time the clock is read; ceil must still say 5m.
		expect(formatRelativeTime(NOW + 5 * MINUTE)).toBe("in 5m");
		expect(formatRelativeTime(NOW + 5 * MINUTE - 1)).toBe("in 5m");
		expect(formatRelativeTime(NOW + MINUTE)).toBe("in 1m");
		expect(formatRelativeTime(NOW + HOUR - 1)).toBe("in 1h");
		expect(formatRelativeTime(NOW + HOUR)).toBe("in 1h");
		expect(formatRelativeTime(NOW + 3 * DAY)).toBe("in 3d");
	});

	it("renders the one-day bucket as Tomorrow/Yesterday", () => {
		expect(formatRelativeTime(NOW + DAY - 1)).toBe("Tomorrow");
		expect(formatRelativeTime(NOW + DAY)).toBe("Tomorrow");
		expect(formatRelativeTime(NOW - DAY)).toBe("Yesterday");
	});

	it("rounds a future moment just past a boundary up to the next unit", () => {
		// "in N <unit>" promises arrival within N units, so 60s+1ms cannot claim
		// "in 1m" — the minimal true N is 2. Same rule at each unit scale.
		expect(formatRelativeTime(NOW + MINUTE + 1)).toBe("in 2m");
		expect(formatRelativeTime(NOW + HOUR + 1)).toBe("in 2h");
		expect(formatRelativeTime(NOW + DAY + 1)).toBe("in 2d");
	});

	it("falls back to a locale date at a week and beyond", () => {
		expect(formatRelativeTime(NOW - 7 * DAY)).not.toMatch(/ago|now/);
		expect(formatRelativeTime(NOW + 7 * DAY)).not.toMatch(/in |now/);
		expect(formatRelativeTime(NOW - 8 * DAY)).not.toMatch(/ago|now/);
		expect(formatRelativeTime(NOW + 8 * DAY)).not.toMatch(/in |now/);
	});

	it("keeps a future moment inside the week relative instead of an early date", () => {
		// A future 6d + 1ms ceils to 7 days but is still inside the week, so it
		// must render "in 7d" rather than jump to an absolute date a full day
		// before a week has elapsed (matching the packages/ui WEEK_MS gate).
		expect(formatRelativeTime(NOW + 6 * DAY + 1)).toBe("in 7d");
		expect(formatRelativeTime(NOW + 7 * DAY - 1)).toBe("in 7d");
	});
});

describe("formatTimestamp (verbose)", () => {
	it("renders sub-minute offsets as 'just now' in both directions", () => {
		expect(formatTimestamp(NOW - MINUTE + 1)).toBe("just now");
		expect(formatTimestamp(NOW + MINUTE - 1)).toBe("just now");
	});

	it("floors past magnitudes, pluralizes, and suffixes 'ago'", () => {
		expect(formatTimestamp(NOW - MINUTE)).toBe("1 minute ago");
		expect(formatTimestamp(NOW - 5 * MINUTE)).toBe("5 minutes ago");
		expect(formatTimestamp(NOW - HOUR)).toBe("1 hour ago");
		expect(formatTimestamp(NOW - 3 * HOUR)).toBe("3 hours ago");
		expect(formatTimestamp(NOW - DAY)).toBe("1 day ago");
		expect(formatTimestamp(NOW - 2 * DAY - HOUR)).toBe("2 days ago");
	});

	it("ceils future magnitudes, pluralizes, and prefixes 'in'", () => {
		expect(formatTimestamp(NOW + MINUTE)).toBe("in 1 minute");
		expect(formatTimestamp(NOW + 5 * MINUTE)).toBe("in 5 minutes");
		expect(formatTimestamp(NOW + 5 * MINUTE - 1)).toBe("in 5 minutes");
		expect(formatTimestamp(NOW + HOUR - 1)).toBe("in 1 hour");
		expect(formatTimestamp(NOW + HOUR)).toBe("in 1 hour");
		expect(formatTimestamp(NOW + DAY - 1)).toBe("in 1 day");
		expect(formatTimestamp(NOW + DAY)).toBe("in 1 day");
		expect(formatTimestamp(NOW + 2 * DAY)).toBe("in 2 days");
	});

	it("rounds a future moment just past a boundary up to the next unit", () => {
		expect(formatTimestamp(NOW + MINUTE + 1)).toBe("in 2 minutes");
		expect(formatTimestamp(NOW + HOUR + 1)).toBe("in 2 hours");
		expect(formatTimestamp(NOW + DAY + 1)).toBe("in 2 days");
	});
});

// JS Date is valid only in ±8.64e15 ms; one past either end is Invalid Date.
const MAX_REPRESENTABLE_MS = 8_640_000_000_000_000;

describe("invalid and unrepresentable timestamps", () => {
	it("fails closed to 'just now' for non-finite inputs", () => {
		expect(formatRelativeTime(Number.NaN)).toBe("just now");
		expect(formatRelativeTime(Number.POSITIVE_INFINITY)).toBe("just now");
		expect(formatRelativeTime(Number.NEGATIVE_INFINITY)).toBe("just now");
		expect(formatTimestamp(Number.NaN)).toBe("just now");
		expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe("just now");
		expect(formatTimestamp(Number.NEGATIVE_INFINITY)).toBe("just now");
	});

	it("fails closed for finite values just outside the Date range", () => {
		expect(formatRelativeTime(MAX_REPRESENTABLE_MS + 1)).toBe("just now");
		expect(formatRelativeTime(-(MAX_REPRESENTABLE_MS + 1))).toBe("just now");
		expect(formatRelativeTime(Number.MAX_VALUE)).toBe("just now");
		expect(formatTimestamp(MAX_REPRESENTABLE_MS + 1)).toBe("just now");
		expect(formatTimestamp(-(MAX_REPRESENTABLE_MS + 1))).toBe("just now");
		expect(formatTimestamp(Number.MAX_VALUE)).toBe("just now");
	});

	it("keeps the ±8.64e15 endpoints representable (no Invalid Date)", () => {
		// Endpoints are valid Dates; output is a huge relative/absolute string,
		// never the browser garbage label.
		expect(formatRelativeTime(MAX_REPRESENTABLE_MS)).not.toBe("Invalid Date");
		expect(formatRelativeTime(-MAX_REPRESENTABLE_MS)).not.toBe("Invalid Date");
		expect(formatTimestamp(MAX_REPRESENTABLE_MS)).not.toBe("Invalid Date");
		expect(formatTimestamp(-MAX_REPRESENTABLE_MS)).not.toBe("Invalid Date");
		expect(formatRelativeTime(MAX_REPRESENTABLE_MS)).not.toBe("just now");
		expect(formatTimestamp(MAX_REPRESENTABLE_MS)).not.toBe("just now");
	});
});
