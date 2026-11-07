/**
 * Real TaskService and PGlite: a failing repeat task never retries sooner than
 * its own cadence. The 5-minute backoff cap bounds growth for short cadences;
 * applied to a daily task it made each failure retry 5 minutes later and
 * auto-paused the task within about 20 minutes.
 */

import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { TaskService } from "../src/services/task";

const T0 = 1_800_000_000_000;
const DAY = 86_400_000;

it("a failing daily task waits a day before it runs again", async () => {
	const { runtime, cleanup } = await createTestRuntime({
		characterName: "DailyBackoff",
	});
	let runs = 0;
	let now = T0;
	try {
		runtime.registerTaskWorker({
			name: "DAILY_DIGEST",
			execute: async () => {
				runs += 1;
				throw new Error("upstream 503");
			},
		});
		const taskId = await runtime.createTask({
			name: "DAILY_DIGEST",
			description: "daily repeat task whose upstream is down",
			tags: ["queue", "repeat"],
			metadata: { updateInterval: DAY, updatedAt: T0 - DAY - 120_000 },
		});
		const service = new TaskService(runtime, {
			now: () => now,
			setInterval: () => {
				throw new Error("manual ticks only");
			},
			clearInterval: () => undefined,
		});
		for (let minute = 0; minute < 60; minute += 1) {
			const due = await runtime.getTasks({
				tags: ["queue"],
				agentIds: [runtime.agentId],
			});
			await service.runTick(due).catch(() => undefined);
			now += 60_000;
		}
		const task = await runtime.getTask(taskId);
		expect(runs).toBe(1);
		expect(task?.metadata?.paused).not.toBe(true);
		expect(task?.metadata?.updateInterval).toBeGreaterThanOrEqual(DAY);
	} finally {
		await cleanup();
	}
}, 120_000);
