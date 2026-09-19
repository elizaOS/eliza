/**
 * A pause that races a repeat task's post-execution persist must survive, and
 * the run's bookkeeping must survive the pause (#31764). Real AgentRuntime with
 * @elizaos/plugin-sql on PGlite and the real TaskService with a manual clock;
 * the SQL adapter's atomic metadata patch is the path under test.
 */
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../testing/pglite-runtime";
import type { UUID } from "../types/primitives";
import { TaskService } from "./task";

const T0 = 1_800_000_000_000;

describe("TaskService pause racing a run on PGlite", () => {
	it("keeps both the pause flag and the run's bookkeeping", async () => {
		const { runtime, cleanup } = await createTestRuntime({
			characterName: "PauseRace",
		});
		try {
			let runs = 0;
			runtime.registerTaskWorker({
				name: "RACE",
				execute: async () => {
					runs += 1;
				},
			});
			const taskId = await runtime.createTask({
				name: "RACE",
				description: "race",
				tags: ["queue", "repeat"],
				metadata: { updateInterval: 60_000, updatedAt: T0 - 120_000 },
			});
			const service = new TaskService(runtime, {
				now: () => T0,
				setInterval: () => {
					throw new Error("manual ticks only");
				},
				clearInterval: () => undefined,
			});
			const tasks = await runtime.getTasks({
				tags: ["queue"],
				agentIds: [runtime.agentId],
			});
			await Promise.all([service.runTick(tasks), service.pauseTask(taskId)]);
			const after = await runtime.getTask(taskId as UUID);
			expect(runs).toBe(1);
			expect(after?.metadata).toMatchObject({
				paused: true,
				updatedAt: T0,
				failureCount: 0,
				updateInterval: 60_000,
			});

			// The paused task is skipped by the next tick and resume clears only the flag.
			const paused = await runtime.getTasks({
				tags: ["queue"],
				agentIds: [runtime.agentId],
			});
			await service.runTick(paused);
			expect(runs).toBe(1);
			await service.resumeTask(taskId);
			expect(await runtime.getTask(taskId as UUID)).toMatchObject({
				metadata: { paused: false, updatedAt: T0, failureCount: 0 },
			});
		} finally {
			await cleanup();
		}
	}, 120_000);
});
