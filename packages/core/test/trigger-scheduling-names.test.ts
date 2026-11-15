/**
 * The Automations form previews 3-letter cron names (`MON`, `JAN`). The
 * scheduler must fire at that same instant. A full weekday name is not a
 * cron field and stays invalid.
 */
import { describe, expect, it } from "vitest";
import {
	computeNextCronRunAtMs,
	parseCronExpression,
} from "../src/services/trigger-scheduling.ts";

const FROM = Date.parse("2026-03-01T00:00:00.000Z");

function next(expression: string, from = FROM): string | null {
	const at = computeNextCronRunAtMs(expression, from, "UTC");
	return at === null ? null : new Date(at).toISOString();
}

describe("cron month and day names", () => {
	it("fires a named weekday at the same time as its number", () => {
		expect(next("0 9 * * MON")).toBe("2026-03-02T09:00:00.000Z");
		expect(next("0 9 * * mon")).toBe(next("0 9 * * 1"));
		expect(next("0 9 * * MON-FRI")).toBe(next("0 9 * * 1-5"));
		expect(next("0 9 * * MON/2")).toBe(next("0 9 * * 1/2"));
		expect(next("0 9 * * SUN,SAT")).toBe(next("0 9 * * 0,6"));
		expect(next("0 9 * * SUN")).toBe(next("0 9 * * 7"));
	});

	it("fires a named month at the same time as its number", () => {
		expect(next("0 0 1 JAN *")).toBe("2027-01-01T00:00:00.000Z");
		expect(next("0 0 1 jan *")).toBe(next("0 0 1 1 *"));
		expect(next("0 0 1 JAN,JUN *")).toBe(next("0 0 1 1,6 *"));
		expect(next("0 0 1 JAN-MAR *")).toBe(next("0 0 1 1-3 *"));
		expect(next("0 9 * JAN MON")).toBe("2027-01-04T09:00:00.000Z");
	});

	it("rejects a name the 5-field schedule cannot run", () => {
		expect(parseCronExpression("0 9 * * Monday")).toBeNull();
		expect(parseCronExpression("0 9 * * FOO")).toBeNull();
		expect(parseCronExpression("0 9 JAN * *")).toBeNull();
		expect(computeNextCronRunAtMs("0 9 * * Monday", FROM, "UTC")).toBeNull();
	});
});
