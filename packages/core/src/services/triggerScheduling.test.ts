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
