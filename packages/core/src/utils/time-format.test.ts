/**
 * Unit tests for the relative-time formatter. Deterministic and self-contained:
 * each case pins an offset from `Date.now()` in the middle of its bucket (so the
 * few milliseconds that elapse inside the call cannot cross a boundary) and
 * asserts the exact rendered string. Covers past, future, and sub-minute
 * offsets for both the compact (`formatRelativeTime`) and verbose
 * (`formatTimestamp`) styles.
 */
import { describe, expect, it } from "vitest";
import { formatRelativeTime, formatTimestamp } from "./time-format";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTime (compact)", () => {
	it("renders sub-minute offsets as 'just now' in both directions", () => {
		expect(formatRelativeTime(Date.now() - 30 * SECOND)).toBe("just now");
		expect(formatRelativeTime(Date.now() + 30 * SECOND)).toBe("just now");
	});

	it("suffixes past offsets with 'ago'", () => {
		expect(formatRelativeTime(Date.now() - (5 * MINUTE + 20 * SECOND))).toBe(
			"5m ago",
		);
		expect(formatRelativeTime(Date.now() - (2 * HOUR + 10 * MINUTE))).toBe(
			"2h ago",
		);
		expect(formatRelativeTime(Date.now() - (1 * DAY + 1 * HOUR))).toBe(
			"Yesterday",
		);
		expect(formatRelativeTime(Date.now() - (3 * DAY + 1 * HOUR))).toBe(
			"3d ago",
		);
	});

	it("prefixes future offsets with 'in' rather than reporting them as past", () => {
		expect(formatRelativeTime(Date.now() + (5 * MINUTE + 20 * SECOND))).toBe(
			"in 5m",
		);
		expect(formatRelativeTime(Date.now() + (2 * HOUR + 10 * MINUTE))).toBe(
			"in 2h",
		);
		expect(formatRelativeTime(Date.now() + (1 * DAY + 1 * HOUR))).toBe(
			"Tomorrow",
		);
		expect(formatRelativeTime(Date.now() + (3 * DAY + 1 * HOUR))).toBe("in 3d");
	});
});

describe("formatTimestamp (verbose)", () => {
	it("pluralizes and suffixes past offsets", () => {
		expect(formatTimestamp(Date.now() - (1 * MINUTE + 20 * SECOND))).toBe(
			"1 minute ago",
		);
		expect(formatTimestamp(Date.now() - (5 * MINUTE + 20 * SECOND))).toBe(
			"5 minutes ago",
		);
		expect(formatTimestamp(Date.now() - (3 * HOUR + 10 * MINUTE))).toBe(
			"3 hours ago",
		);
		expect(formatTimestamp(Date.now() - (2 * DAY + 1 * HOUR))).toBe(
			"2 days ago",
		);
	});

	it("prefixes future offsets with 'in' and keeps pluralization", () => {
		expect(formatTimestamp(Date.now() + (1 * MINUTE + 20 * SECOND))).toBe(
			"in 1 minute",
		);
		expect(formatTimestamp(Date.now() + (5 * MINUTE + 20 * SECOND))).toBe(
			"in 5 minutes",
		);
		expect(formatTimestamp(Date.now() + (3 * HOUR + 10 * MINUTE))).toBe(
			"in 3 hours",
		);
		expect(formatTimestamp(Date.now() + (2 * DAY + 1 * HOUR))).toBe(
			"in 2 days",
		);
	});
});
