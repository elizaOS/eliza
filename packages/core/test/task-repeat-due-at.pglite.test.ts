/**
 * A repeat task created with a future dueAt waits for it. Before this floor
 * the repeat branch read lastRan as 0 for a row that never ran and fired it
 * on the next tick: the Blooio receipt cleanup scheduled seven days out
 * deleted its dedupe receipt one second after the webhook was answered.
 */
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { TaskService } from "../src/services/task";

const HOUR = 60 * 60 * 1000;
const WEEK = 7 * 24 * HOUR;

it("a repeat task with a future dueAt does not run before it", async () => {
	const f = await createTestRuntime({ characterName: "RepeatDueAt" });
	let now = Date.parse("2026-07-01T10:00:00.000Z");
	let runs = 0;
	const service = new TaskService(f.runtime, {
		now: () => now,
		setInterval: () => 1,
		clearInterval: () => {},
	});
	try {
		f.runtime.registerTaskWorker({
			name: "RECEIPT_CLEANUP",
			execute: async () => {
				runs++;
				return undefined;
			},
		});
		await f.runtime.createTask({
			name: "RECEIPT_CLEANUP",
			tags: ["queue", "repeat"],
			metadata: { updateInterval: HOUR, maxFailures: 0 },
			dueAt: now + WEEK,
		});

		// The next tick, and a tick an hour later, must leave the row alone.
		await service.runDueTasks();
		now += 1_000;
		await service.runDueTasks();
		now += HOUR;
		await service.runDueTasks();
		expect(runs).toBe(0);

		// Once dueAt has passed the row runs like any repeat row.
		now += WEEK;
		await service.runDueTasks();
		expect(runs).toBe(1);

		// After the first run the row repeats on its interval.
		now += HOUR;
		await service.runDueTasks();
		expect(runs).toBe(2);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});

it("an explicit wake request still runs a repeat task before its dueAt", async () => {
	const f = await createTestRuntime({ characterName: "RepeatDueAtWake" });
	const now = Date.parse("2026-07-01T10:00:00.000Z");
	let runs = 0;
	const service = new TaskService(f.runtime, {
		now: () => now,
		setInterval: () => 1,
		clearInterval: () => {},
	});
	try {
		f.runtime.registerTaskWorker({
			name: "RECEIPT_CLEANUP",
			execute: async () => {
				runs++;
				return undefined;
			},
		});
		const id = await f.runtime.createTask({
			name: "RECEIPT_CLEANUP",
			tags: ["queue", "repeat"],
			metadata: { updateInterval: HOUR, maxFailures: 0 },
			dueAt: now + WEEK,
		});
		await service.runDueTasks();
		expect(runs).toBe(0);

		await f.runtime.patchTaskMetadata(id, { wake: { requestAt: now } });
		await service.runDueTasks();
		expect(runs).toBe(1);
	} finally {
		await service.stop();
		await f.cleanup();
	}
});
