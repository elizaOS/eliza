import { describe, expect, it, vi } from "vitest";
import { logger } from "../logger";
import {
	computeNextCronRunAtMs,
	parseCronExpression,
} from "./triggerScheduling.ts";

const minutes = (expr: string): number[] => {
	const schedule = parseCronExpression(expr);
	if (!schedule) throw new Error(`expected ${expr} to parse`);
	return Array.from(schedule.minute).sort((a, b) => a - b);
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

describe("computeNextCronRunAtMs - timezone handling", () => {
	it("evaluates a valid IANA zone at the local hour", () => {
		// 2026-05-10 is US daylight time: America/Denver = UTC-6.
		const base = Date.UTC(2026, 4, 10, 8, 0, 0);
		const next = computeNextCronRunAtMs("0 9 * * *", base, "America/Denver");
		expect(next).toBe(Date.UTC(2026, 4, 10, 15, 0, 0));
	});

	it("warns once for an invalid zone and falls back to UTC explicitly", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const base = Date.UTC(2026, 4, 10, 8, 0, 0);
			const zone = "Not_A/Real_Zone";
			const first = computeNextCronRunAtMs("0 9 * * *", base, zone);
			expect(first).toBe(Date.UTC(2026, 4, 10, 9, 0, 0)); // UTC fallback
			const warnsAfterFirst = warnSpy.mock.calls.filter((call) =>
				String(call[0]).includes(zone),
			).length;
			expect(warnsAfterFirst).toBe(1); // once per zone, not once per candidate minute

			computeNextCronRunAtMs("0 9 * * *", base, zone);
			const warnsAfterSecond = warnSpy.mock.calls.filter((call) =>
				String(call[0]).includes(zone),
			).length;
			expect(warnsAfterSecond).toBe(1); // still once across calls
		} finally {
			warnSpy.mockRestore();
		}
	});

	it("treats the unresolved owner_local sentinel as an invalid zone (UTC + warning)", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const base = Date.UTC(2026, 4, 10, 8, 0, 0);
			const next = computeNextCronRunAtMs("0 9 * * *", base, "owner_local");
			expect(next).toBe(Date.UTC(2026, 4, 10, 9, 0, 0));
			expect(
				warnSpy.mock.calls.some((call) =>
					String(call[0]).includes("owner_local"),
				),
			).toBe(true);
		} finally {
			warnSpy.mockRestore();
		}
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

describe("computeNextCronRunAtMs - DST fall-back regression coverage (#11046)", () => {
	const NY = "America/New_York";
	// Europe/Berlin fall-back: 2026-10-25 03:00 CEST -> 02:00 CET
	// (transition instant 01:00:00Z). Local 02:00-02:59 happens twice.
	const BERLIN = "Europe/Berlin";

	it("Berlin: a cron inside the repeated hour fires once (02:30 CEST), then the next local day", () => {
		const beforeTransition = Date.UTC(2026, 9, 25, 0, 0, 0);
		const first = computeNextCronRunAtMs(
			"30 2 * * *",
			beforeTransition,
			BERLIN,
		);
		expect(first).toBe(Date.UTC(2026, 9, 25, 0, 30, 0)); // 02:30 CEST
		const next = computeNextCronRunAtMs("30 2 * * *", first as number, BERLIN);
		// NOT 2026-10-25T01:30Z (02:30 CET — the repeated pass).
		expect(next).toBe(Date.UTC(2026, 9, 26, 1, 30, 0)); // Oct 26 02:30 CET
	});

	it("spring-forward skipped-hour behavior is unchanged (02:30 never exists on 2026-03-08)", () => {
		const beforeTransition = Date.UTC(2026, 2, 8, 0, 0, 0); // Mar 7 19:00 EST
		const next = computeNextCronRunAtMs("30 2 * * *", beforeTransition, NY);
		expect(next).toBe(Date.UTC(2026, 2, 9, 6, 30, 0)); // Mar 9 02:30 EDT — Mar 8 skipped
	});

	it("daily crons outside the transition hour still fire exactly once per local day across fall-back", () => {
		const fired = Date.UTC(2026, 9, 31, 12, 0, 0); // Oct 31 08:00 EDT
		const next = computeNextCronRunAtMs("0 8 * * *", fired, NY);
		expect(next).toBe(Date.UTC(2026, 10, 1, 13, 0, 0)); // Nov 1 08:00 EST — 25h later
		const after = computeNextCronRunAtMs("0 8 * * *", next as number, NY);
		expect(after).toBe(Date.UTC(2026, 10, 2, 13, 0, 0));
	});

	it("a rare-match cron with a timezone completes a full 366-day scan fast (hoisted formatter)", () => {
		// Feb 29 does not occur inside the 366-day window from 2026-03-01, so
		// this is the worst case: a full valid-base scan returning null. With a
		// fresh formatter per candidate minute this took tens of seconds.
		const startedAt = performance.now();
		const next = computeNextCronRunAtMs("0 0 29 2 *", Date.UTC(2026, 2, 1), NY);
		const elapsedMs = performance.now() - startedAt;
		expect(next).toBeNull();
		expect(elapsedMs).toBeLessThan(3000);
	});

	it("returns null fast (never throws) for a base below the negative representable range", () => {
		// Every candidate from such a base is an Invalid Date; without the
		// symmetric bail the tz formatter would throw a RangeError on the first
		// candidate instead of reporting "no next run".
		const startedAt = performance.now();
		expect(
			computeNextCronRunAtMs("* * * * *", -Number.MAX_SAFE_INTEGER, NY),
		).toBeNull();
		expect(performance.now() - startedAt).toBeLessThan(2000);
	});
});
