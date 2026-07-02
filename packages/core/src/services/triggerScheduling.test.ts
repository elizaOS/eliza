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

describe("computeNextCronRunAtMs - DST fall-back single fire (#11046)", () => {
	// America/New_York fall-back: 2026-11-01 02:00 EDT -> 01:00 EST
	// (transition instant 06:00:00Z). Local 01:00-01:59 happens twice:
	// 05:00-05:59Z (EDT) and 06:00-06:59Z (EST).
	const NY = "America/New_York";
	// Europe/Berlin fall-back: 2026-10-25 03:00 CEST -> 02:00 CET
	// (transition instant 01:00:00Z). Local 02:00-02:59 happens twice.
	const BERLIN = "Europe/Berlin";

	it("NY: a cron inside the repeated hour fires on the first pass (01:30 EDT)", () => {
		const midnightLocal = Date.UTC(2026, 10, 1, 4, 0, 0); // 00:00 EDT
		const next = computeNextCronRunAtMs("30 1 * * *", midnightLocal, NY);
		expect(next).toBe(Date.UTC(2026, 10, 1, 5, 30, 0)); // 01:30 EDT
	});

	it("NY: the second wall-clock pass is skipped — next fire is the following local day", () => {
		const firstPass = Date.UTC(2026, 10, 1, 5, 30, 0); // 01:30 EDT
		const next = computeNextCronRunAtMs("30 1 * * *", firstPass, NY);
		// NOT 2026-11-01T06:30Z (01:30 EST — the old double fire).
		expect(next).toBe(Date.UTC(2026, 10, 2, 6, 30, 0)); // Nov 2 01:30 EST
	});

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

	it("hour-wildcard schedules keep firing on both passes (hourly cadence is not deduped)", () => {
		const firstPass = Date.UTC(2026, 10, 1, 5, 30, 0); // 01:30 EDT
		const next = computeNextCronRunAtMs("30 * * * *", firstPass, NY);
		expect(next).toBe(Date.UTC(2026, 10, 1, 6, 30, 0)); // 01:30 EST — a real hour later
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
});

describe("computeNextCronRunAtMs - pathological scan cost (#11046)", () => {
	it("a rare-match cron with a timezone completes a full 366-day scan fast", () => {
		// Feb 29 next occurs in 2028 — outside the 366-day window from
		// 2026-03-01, so this is the worst case: a full scan returning null.
		const startedAt = performance.now();
		const next = computeNextCronRunAtMs(
			"0 0 29 2 *",
			Date.UTC(2026, 2, 1),
			"America/New_York",
		);
		const elapsedMs = performance.now() - startedAt;
		expect(next).toBeNull();
		expect(elapsedMs).toBeLessThan(3000);
	});

	it("bails immediately on non-finite and non-representable bases", () => {
		const startedAt = performance.now();
		expect(
			computeNextCronRunAtMs("0 0 * * *", Number.NaN, "America/New_York"),
		).toBeNull();
		expect(
			computeNextCronRunAtMs(
				"0 0 * * *",
				Number.POSITIVE_INFINITY,
				"America/New_York",
			),
		).toBeNull();
		// Beyond the max representable Date: every candidate would be an
		// Invalid Date, so the scan returns null without iterating (was ~26s).
		expect(
			computeNextCronRunAtMs(
				"0 0 * * *",
				8_640_000_000_000_000 + 60_000,
				"America/New_York",
			),
		).toBeNull();
		expect(performance.now() - startedAt).toBeLessThan(1000);
	});
});
