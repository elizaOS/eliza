import { describe, expect, test } from "vitest";
import {
	computeNextCronRunAtMs,
	MAX_TRIGGER_INTERVAL_MS,
	MIN_TRIGGER_INTERVAL_MS,
	normalizeTriggerIntervalMs,
	parseCronExpression,
	resolveTriggerTiming,
} from "../services/triggerScheduling";
import {
	TRIGGER_SCHEMA_VERSION,
	type TriggerConfig,
	type UUID,
} from "../types";

const baseTrigger = (overrides: Partial<TriggerConfig>): TriggerConfig =>
	({
		version: TRIGGER_SCHEMA_VERSION,
		triggerId: "00000000-0000-0000-0000-000000000111" as UUID,
		displayName: "Test Trigger",
		instructions: "Do work",
		triggerType: "interval",
		enabled: true,
		wakeMode: "inject_now",
		createdBy: "tester",
		runCount: 0,
		...overrides,
	}) as TriggerConfig;

describe("triggerScheduling", () => {
	test("normalizes interval bounds", () => {
		expect(normalizeTriggerIntervalMs(1)).toBe(MIN_TRIGGER_INTERVAL_MS);
		expect(normalizeTriggerIntervalMs(MAX_TRIGGER_INTERVAL_MS + 1)).toBe(
			MAX_TRIGGER_INTERVAL_MS,
		);
		expect(normalizeTriggerIntervalMs(120_000)).toBe(120_000);
	});

	test("parses valid cron expression", () => {
		const parsed = parseCronExpression("*/15 8-18 * * 1-5");
		expect(parsed).not.toBeNull();
	});

	test("rejects invalid cron expression", () => {
		expect(parseCronExpression("invalid cron")).toBeNull();
		expect(parseCronExpression("* * *")).toBeNull();
		expect(parseCronExpression("61 * * * *")).toBeNull();
	});

	test("computes next cron run at expected minute boundary", () => {
		const from = Date.UTC(2026, 0, 1, 12, 7, 13);
		const next = computeNextCronRunAtMs("*/15 * * * *", from);
		expect(next).toBe(Date.UTC(2026, 0, 1, 12, 15, 0));
	});

	test("resolves interval trigger timing", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const trigger = baseTrigger({
			triggerType: "interval",
			intervalMs: 300_000,
		});
		const timing = resolveTriggerTiming(trigger, now);
		expect(timing).not.toBeNull();
		expect(timing?.updateIntervalMs).toBe(300_000);
		expect(timing?.nextRunAtMs).toBe(now + 300_000);
	});

	test("resolves once trigger timing", () => {
		const now = Date.UTC(2026, 0, 1, 0, 0, 0);
		const scheduledAt = new Date(now + 3_600_000).toISOString();
		const trigger = baseTrigger({
			triggerType: "once",
			scheduledAtIso: scheduledAt,
		});
		const timing = resolveTriggerTiming(trigger, now);
		expect(timing).not.toBeNull();
		expect(timing?.nextRunAtMs).toBe(now + 3_600_000);
	});

	test("resolves cron trigger timing", () => {
		const now = Date.UTC(2026, 0, 1, 12, 7, 0);
		const trigger = baseTrigger({
			triggerType: "cron",
			cronExpression: "0 */2 * * *",
		});
		const timing = resolveTriggerTiming(trigger, now);
		expect(timing).not.toBeNull();
		expect(timing?.nextRunAtMs).toBe(Date.UTC(2026, 0, 1, 14, 0, 0));
	});
});
