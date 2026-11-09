/**
 * A past-due once trigger must resolve to a positive interval: 0 makes the
 * scheduler reject the repeat task as TASK_SCHEDULE_INVALID on every tick,
 * so the task never fires and never dies.
 */
import { describe, expect, it } from "vitest";
import { resolveTriggerTiming } from "../src/services/trigger-scheduling.ts";
import type { TriggerConfig } from "../src/types/trigger";

function onceTrigger(scheduledAtIso: string): TriggerConfig {
	return {
		triggerType: "once",
		enabled: true,
		scheduledAtIso,
	} as TriggerConfig;
}

describe("resolveTriggerTiming for once triggers", () => {
	it("resolves a past-due once trigger to a positive interval, due now", () => {
		const now = Date.parse("2026-11-10T03:00:00.000Z");
		const timing = resolveTriggerTiming(
			onceTrigger(new Date(now - 60_000).toISOString()),
			now,
		);
		expect(timing).not.toBeNull();
		expect(timing?.nextRunAtMs).toBe(now);
		expect(timing?.updateIntervalMs).toBeGreaterThan(0);
	});

	it("resolves a once trigger scheduled exactly now to a positive interval", () => {
		const now = Date.parse("2026-11-10T03:00:00.000Z");
		const timing = resolveTriggerTiming(
			onceTrigger(new Date(now).toISOString()),
			now,
		);
		expect(timing?.updateIntervalMs).toBeGreaterThan(0);
		expect(timing?.nextRunAtMs).toBe(now);
	});

	it("keeps a future once trigger interval unchanged", () => {
		const now = Date.parse("2026-11-10T03:00:00.000Z");
		const timing = resolveTriggerTiming(
			onceTrigger(new Date(now + 60_000).toISOString()),
			now,
		);
		expect(timing?.updateIntervalMs).toBe(60_000);
		expect(timing?.nextRunAtMs).toBe(now + 60_000);
	});
});
