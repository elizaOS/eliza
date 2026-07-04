/**
 * Tests for the trigger cron parser and next-run computation: `N/step`
 * expansion, the Sunday-as-7 alias, DST fall-back dedupe, POSIX dom/dow OR
 * semantics, and the non-representable-base guard.
 */
import { describe, expect, it } from "vitest";
import {
	computeNextCronRunAtMs,
	parseCronExpression,
} from "./triggerScheduling.ts";

const minutes = (expr: string): number[] => {
	const schedule = parseCronExpression(expr);
	if (!schedule) throw new Error(`expected ${expr} to parse`);
	return Array.from(schedule.minute).sort((a, b) => a - b);
};

const daysOfWeek = (expr: string): number[] => {
	const schedule = parseCronExpression(expr);
	if (!schedule) throw new Error(`expected ${expr} to parse`);
	return Array.from(schedule.dayOfWeek).sort((a, b) => a - b);
};

describe("parseCronExpression - minute field", () => {
	it("expands `N/step` from N to the field max (regression: previously dropped the step)", () => {
		// `5/15` means 5,20,35,50 — not just [5].
		expect(minutes("5/15 * * * *")).toEqual([5, 20, 35, 50]);
		expect(minutes("0/20 * * * *")).toEqual([0, 20, 40]);
		expect(minutes("7/30 * * * *")).toEqual([7, 37]);
	});

	it("keeps a bare single value as just that value", () => {
		expect(minutes("5 * * * *")).toEqual([5]);
		expect(minutes("0 * * * *")).toEqual([0]);
	});

	it("supports `*/step`, ranges, `range/step`, and lists", () => {
		expect(minutes("*/15 * * * *")).toEqual([0, 15, 30, 45]);
		expect(minutes("0-30/10 * * * *")).toEqual([0, 10, 20, 30]);
		expect(minutes("10-12 * * * *")).toEqual([10, 11, 12]);
		expect(minutes("1,2,3 * * * *")).toEqual([1, 2, 3]);
		expect(minutes("5/15,1 * * * *")).toEqual([1, 5, 20, 35, 50]);
	});

	it("rejects malformed expressions", () => {
		expect(parseCronExpression("60 * * * *")).toBeNull(); // out of range
		expect(parseCronExpression("*/0 * * * *")).toBeNull(); // zero step
		expect(parseCronExpression("1-2-3 * * * *")).toBeNull(); // bad range
		expect(parseCronExpression("* * * *")).toBeNull(); // too few fields
	});
});

describe("parseCronExpression - day-of-week Sunday alias (7 == 0)", () => {
	// POSIX/Vixie cron accepts BOTH 0 and 7 for Sunday, and LLMs commonly emit
	// `7`; the parser accepts `7` (single, range end, or step) and folds it onto
	// Sunday (0) rather than hard-failing trigger creation.
	it("accepts a bare `7` and folds it onto Sunday (0)", () => {
		expect(daysOfWeek("0 0 * * 7")).toEqual([0]);
	});

	it("accepts ranges ending in `7` (e.g. `5-7` = Fri/Sat/Sun)", () => {
		expect(daysOfWeek("0 0 * * 5-7")).toEqual([0, 5, 6]);
		expect(daysOfWeek("0 0 * * 0-7")).toEqual([0, 1, 2, 3, 4, 5, 6]);
	});

	it("accepts `7` inside a comma list and dedupes against a literal 0", () => {
		expect(daysOfWeek("0 0 * * 0,7")).toEqual([0]);
		expect(daysOfWeek("0 0 * * 1,7")).toEqual([0, 1]);
	});

	it("still accepts the canonical `0` for Sunday", () => {
		expect(daysOfWeek("0 0 * * 0")).toEqual([0]);
	});

	it("does not accept `7` in fields where it is not a Sunday alias", () => {
		// minute/hour ranges are unchanged: `7` is a valid minute but the
		// Sunday-alias relaxation must not bleed into other fields.
		expect(parseCronExpression("0 0 * * 8")).toBeNull(); // dow out of range
		expect(parseCronExpression("0 0 * 13 *")).toBeNull(); // month still max 12
	});
});

describe("computeNextCronRunAtMs - `N/step` schedules recurringly", () => {
	it("fires at the next stepped minute, not only the start minute", () => {
		// 2024-01-01T00:06:00Z — next `5/15` slot is :20, then :35.
		const base = Date.UTC(2024, 0, 1, 0, 6, 0);
		const next = computeNextCronRunAtMs("5/15 * * * *", base, "UTC");
		expect(next).toBe(Date.UTC(2024, 0, 1, 0, 20, 0));
		const after = computeNextCronRunAtMs("5/15 * * * *", next as number, "UTC");
		expect(after).toBe(Date.UTC(2024, 0, 1, 0, 35, 0));
	});
});

describe("computeNextCronRunAtMs - DST fall-back dedupe (#11046)", () => {
	// America/New_York falls back 2026-11-01 02:00 EDT -> 01:00 EST, so local
	// 01:30 occurs twice: 05:30Z (EDT) and 06:30Z (EST). A daily `30 1 * * *`
	// must fire ONCE that day (the first instant), not once per pass.
	const NY = "America/New_York";
	const at = (iso: string) => Date.parse(iso);

	it("fires the FIRST instant of the repeated hour", () => {
		// From the prior day's fire, the next run is the EDT (first) pass.
		expect(
			computeNextCronRunAtMs("30 1 * * *", at("2026-10-31T05:30:00.000Z"), NY),
		).toBe(at("2026-11-01T05:30:00.000Z"));
	});

	it("does NOT double-fire at the repeated hour's second instant", () => {
		// Immediately after the EDT fire, the next run skips the EST duplicate
		// (06:30Z same day) and lands on the next local day (01:30 EST).
		expect(
			computeNextCronRunAtMs("30 1 * * *", at("2026-11-01T05:30:00.000Z"), NY),
		).toBe(at("2026-11-02T06:30:00.000Z"));
	});

	it("resumes normal once-per-day firing after the transition", () => {
		expect(
			computeNextCronRunAtMs("30 1 * * *", at("2026-11-02T06:30:00.000Z"), NY),
		).toBe(at("2026-11-03T06:30:00.000Z"));
	});

	it("dedupes non-hour fall-back offsets such as Lord Howe's 30-minute transition", () => {
		const lordHowe = "Australia/Lord_Howe";
		// Lord Howe falls back by 30 minutes on 2026-04-05: local 01:45 occurs
		// at 14:45Z (UTC+11) and again at 15:15Z (UTC+10:30). The second instant
		// must not be treated as a separate cron fire.
		expect(
			computeNextCronRunAtMs(
				"45 1 * * *",
				at("2026-04-03T14:45:00.000Z"),
				lordHowe,
			),
		).toBe(at("2026-04-04T14:45:00.000Z"));
		expect(
			computeNextCronRunAtMs(
				"45 1 * * *",
				at("2026-04-04T14:45:00.000Z"),
				lordHowe,
			),
		).toBe(at("2026-04-05T15:15:00.000Z"));
	});
});

describe("computeNextCronRunAtMs - POSIX day-of-month/day-of-week OR semantics", () => {
	// Standard (POSIX/Vixie) cron: when BOTH dom and dow are restricted, the
	// job runs on days matching EITHER field. `0 0 13 * 5` = every 13th AND
	// every Friday — not only Friday-the-13th.
	const FRIDAY_JUL_3 = Date.UTC(2026, 6, 3, 12, 0, 0); // 2026-07-03 (a Friday)

	it("sanity: the base date is a Friday", () => {
		expect(new Date(FRIDAY_JUL_3).getUTCDay()).toBe(5);
	});

	it("fires on the next matching day-of-week even when the day-of-month has not arrived", () => {
		// Next Friday (Jul 10) comes before the next 13th (Jul 13). AND
		// semantics would instead wait months for a Friday-the-13th
		// (2026-11-13).
		expect(computeNextCronRunAtMs("0 0 13 * 5", FRIDAY_JUL_3)).toBe(
			Date.UTC(2026, 6, 10, 0, 0, 0),
		);
	});

	it("fires on the next matching day-of-month when it comes before the day-of-week", () => {
		// `0 0 5 * 1`: the 5th (Sunday Jul 5) comes before the next Monday
		// (Jul 6).
		expect(computeNextCronRunAtMs("0 0 5 * 1", FRIDAY_JUL_3)).toBe(
			Date.UTC(2026, 6, 5, 0, 0, 0),
		);
	});

	it("keeps AND semantics when only one day field is restricted", () => {
		// dom restricted, dow `*`: fire on the 13th regardless of weekday.
		expect(computeNextCronRunAtMs("0 0 13 * *", FRIDAY_JUL_3)).toBe(
			Date.UTC(2026, 6, 13, 0, 0, 0),
		);
		// dow restricted, dom `*`: fire on the next Monday.
		expect(computeNextCronRunAtMs("0 0 * * 1", FRIDAY_JUL_3)).toBe(
			Date.UTC(2026, 6, 6, 0, 0, 0),
		);
		// dom `*/2` starts with `*` => unrestricted for the OR rule (Vixie):
		// dow must ALSO match, so the next fire is a Monday on an odd
		// day-of-month (Jul 6 is Monday the 6th — even — so Jul 13 it is).
		expect(computeNextCronRunAtMs("0 0 */2 * 1", FRIDAY_JUL_3)).toBe(
			Date.UTC(2026, 6, 13, 0, 0, 0),
		);
	});
});

describe("computeNextCronRunAtMs - non-representable base guard (#11046)", () => {
	it("returns null immediately for a base at/over the max representable Date", () => {
		// Number.MAX_SAFE_INTEGER (~9.007e15) exceeds the max Date (±8.64e15), so
		// every scanned candidate would be an Invalid Date. The guard bails instead
		// of scanning ~366 days of Invalid-Date minutes.
		const started = performance.now();
		const result = computeNextCronRunAtMs(
			"0 0 29 2 *",
			Number.MAX_SAFE_INTEGER,
			"America/New_York",
		);
		const elapsedMs = performance.now() - started;
		expect(result).toBeNull();
		// Was a ~26s Invalid-Date scan without the guard; a generous ceiling.
		expect(elapsedMs).toBeLessThan(2000);
	});

	it("returns null for non-finite bases", () => {
		expect(computeNextCronRunAtMs("* * * * *", Number.NaN)).toBeNull();
		expect(
			computeNextCronRunAtMs("* * * * *", Number.POSITIVE_INFINITY),
		).toBeNull();
	});
});
