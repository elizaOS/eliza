/**
 * Regression coverage for the cron parser in
 * `packages/core/src/services/triggerScheduling.ts`.
 *
 * The parser had zero tests, and `parseCronPart` historically dropped the step
 * in the `N/step` shorthand (e.g. `5/15`) — it fired only at minute N instead of
 * `N, N+step, …` up to the field max. Any user/LLM cron using that common form
 * silently mis-scheduled. These tests lock the standard-cron semantics in.
 */

import { describe, expect, it } from "vitest";
import {
	computeNextCronRunAtMs,
	parseCronExpression,
} from "../services/triggerScheduling";

/** Sorted array view of a parsed cron field's value set. */
function sorted(set: Set<number> | undefined): number[] {
	return set ? [...set].sort((a, b) => a - b) : [];
}

describe("parseCronExpression — minute field semantics", () => {
	it("expands `N/step` from N to the field max (the regression)", () => {
		const schedule = parseCronExpression("5/15 * * * *");
		expect(schedule).not.toBeNull();
		// The bug produced just [5]; correct cron is 5, 20, 35, 50.
		expect(sorted(schedule?.minute)).toEqual([5, 20, 35, 50]);
	});

	it("expands `*/step` across the whole range", () => {
		expect(sorted(parseCronExpression("*/15 * * * *")?.minute)).toEqual([
			0, 15, 30, 45,
		]);
	});

	it("expands `range/step`", () => {
		expect(sorted(parseCronExpression("10-30/10 * * * *")?.minute)).toEqual([
			10, 20, 30,
		]);
	});

	it("keeps comma lists", () => {
		expect(sorted(parseCronExpression("1,2,3 * * * *")?.minute)).toEqual([
			1, 2, 3,
		]);
	});

	it("treats a bare value as a single match (no step expansion)", () => {
		expect(sorted(parseCronExpression("5 * * * *")?.minute)).toEqual([5]);
	});

	it("expands an inclusive range", () => {
		expect(sorted(parseCronExpression("3-6 * * * *")?.minute)).toEqual([
			3, 4, 5, 6,
		]);
	});
});

describe("parseCronExpression — validation", () => {
	it("rejects the wrong field count", () => {
		expect(parseCronExpression("* * * *")).toBeNull();
		expect(parseCronExpression("* * * * * *")).toBeNull();
	});

	it("rejects out-of-range values", () => {
		expect(parseCronExpression("60 * * * *")).toBeNull(); // minute max is 59
		expect(parseCronExpression("* 24 * * *")).toBeNull(); // hour max is 23
	});

	it("rejects non-numeric / malformed parts", () => {
		expect(parseCronExpression("bad * * * *")).toBeNull();
		expect(parseCronExpression("5/0 * * * *")).toBeNull(); // zero step
		expect(parseCronExpression("")).toBeNull();
	});

	it("parses a fully-specified expression across all five fields", () => {
		const schedule = parseCronExpression("30 9 1 1 1");
		expect(schedule).not.toBeNull();
		expect(sorted(schedule?.minute)).toEqual([30]);
		expect(sorted(schedule?.hour)).toEqual([9]);
		expect(sorted(schedule?.dayOfMonth)).toEqual([1]);
		expect(sorted(schedule?.month)).toEqual([1]);
		expect(sorted(schedule?.dayOfWeek)).toEqual([1]);
	});
});

describe("computeNextCronRunAtMs — behavioral", () => {
	// Fixed UTC instant: 2026-01-01T00:00:00Z (deterministic; no Date.now()).
	const from = Date.UTC(2026, 0, 1, 0, 0, 0);

	it("lands the next run on a `N/step` minute boundary", () => {
		const next = computeNextCronRunAtMs("5/15 * * * *", from, "UTC");
		expect(next).not.toBeNull();
		// First boundary after 00:00 is 00:05.
		expect(next).toBe(Date.UTC(2026, 0, 1, 0, 5, 0));
		expect([5, 20, 35, 50]).toContain(new Date(next as number).getUTCMinutes());
	});

	it("advances strictly past the from-time", () => {
		// from is exactly on a matching minute; the next run must be the following one.
		const onBoundary = Date.UTC(2026, 0, 1, 0, 5, 0);
		const next = computeNextCronRunAtMs("5/15 * * * *", onBoundary, "UTC");
		expect(next).toBe(Date.UTC(2026, 0, 1, 0, 20, 0));
	});

	it("returns null for an invalid expression", () => {
		expect(computeNextCronRunAtMs("nonsense", from, "UTC")).toBeNull();
	});
});
