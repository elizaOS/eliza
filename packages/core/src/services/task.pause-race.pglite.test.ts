/**
 * Real TaskService and PGlite preserve operator pause state and run bookkeeping
 * across both stale-snapshot write orders. Barriers delay completed reads only;
 * every read and metadata mutation still executes against the real SQL adapter.
 */
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../testing/pglite-runtime";
import type { UUID } from "../types/primitives";
import { TaskService } from "./task";

const T0 = 1_800_000_000_000;

function barrier() {
	let release!: () => void;
	const reached = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { reached, release };
}

describe("TaskService pause racing a run on PGlite", () => {
	for (const order of ["pause-first", "bookkeeping-first"] as const) {
		for (const outcome of ["success", "failure"] as const) {
			it(`preserves ${outcome} bookkeeping with ${order} after stale reads`, async () => {
				const { runtime, cleanup } = await createTestRuntime({
					characterName: "PauseRace",
				});
				const workerEntered = barrier();
				const finishWorker = barrier();
				const snapshotRead = barrier();
				const releaseSnapshot = barrier();
				const originalGetTask = runtime.getTask.bind(runtime);
				let holdNextRead = false;
				let racedTaskId: UUID | undefined;
				let runs = 0;
				let now = T0;
				const pending: Promise<void>[] = [];
				runtime.getTask = async (id) => {
					const snapshot = await originalGetTask(id);
					if (holdNextRead && id === racedTaskId) {
						holdNextRead = false;
						snapshotRead.release();
						await releaseSnapshot.reached;
					}
					return snapshot;
				};
				try {
					runtime.registerTaskWorker({
						name: "RACE",
						execute: async () => {
							runs += 1;
							if (runs === 1) {
								workerEntered.release();
								await finishWorker.reached;
								if (outcome === "failure")
									throw new Error("controlled worker failure");
							}
							return { nextInterval: 45_000 };
						},
					});
					const taskId = await runtime.createTask({
						name: "RACE",
						description: "operator pause during a running repeat task",
						tags: ["queue", "repeat"],
						metadata: {
							updateInterval: 60_000,
							baseInterval: 10_000,
							updatedAt: T0 - 120_000,
							failureCount: 1,
							maxFailures: 8,
							lastError: "previous worker failure",
						},
					});
					racedTaskId = taskId;
					const service = new TaskService(runtime, {
						now: () => now,
						setInterval: () => {
							throw new Error("manual ticks only");
						},
						clearInterval: () => undefined,
					});
					const select = () =>
						runtime.getTasks({ tags: ["queue"], agentIds: [runtime.agentId] });
					const tickExecution = service.runTick(await select());
					const tick =
						outcome === "failure"
							? expect(tickExecution).rejects.toMatchObject({
									code: "TASK_TICK_FAILED",
								})
							: tickExecution;
					pending.push(tick);
					await Promise.race([
						workerEntered.reached,
						tick.then(() => {
							throw new Error("Tick completed before entering worker");
						}),
					]);
					holdNextRead = true;
					if (order === "pause-first") {
						// Hold the run's completed read, then commit the pause before the run writes.
						finishWorker.release();
						await Promise.race([
							snapshotRead.reached,
							tick.then(() => {
								throw new Error(
									"Tick completed before bookkeeping read barrier",
								);
							}),
						]);
						await service.pauseTask(taskId);
						releaseSnapshot.release();
						await tick;
					} else {
						// Hold the pause's completed read while the run commits newer bookkeeping.
						const pause = service.pauseTask(taskId);
						pending.push(pause);
						await Promise.race([
							snapshotRead.reached,
							pause.then(() => {
								throw new Error("Pause completed before snapshot barrier");
							}),
						]);
						finishWorker.release();
						await tick;
						releaseSnapshot.release();
						await pause;
					}
					const after = await runtime.getTask(taskId);
					expect(runs).toBe(1);
					expect(after?.metadata).toMatchObject({
						paused: true,
						updatedAt: T0,
						maxFailures: 8,
						failureCount: outcome === "success" ? 0 : 2,
						updateInterval: outcome === "success" ? 45_000 : 40_000,
					});
					if (outcome === "success") {
						expect(after?.metadata).not.toHaveProperty("lastError");
						expect(after?.metadata).not.toHaveProperty("baseInterval");
					} else {
						expect(after?.metadata).toMatchObject({
							lastError: "controlled worker failure",
							baseInterval: 10_000,
						});
					}
					now += 600_000;
					await service.runTick(await select());
					expect(runs).toBe(1);
					await service.resumeTask(taskId);
					expect((await runtime.getTask(taskId))?.metadata).toEqual({
						...after?.metadata,
						paused: false,
					});
					await service.runTick(await select());
					expect(runs).toBe(2);
					const resumed = await runtime.getTask(taskId);
					expect(resumed?.metadata).toMatchObject({
						paused: false,
						updatedAt: now,
						failureCount: 0,
						updateInterval: 45_000,
					});
					expect(resumed?.metadata).not.toHaveProperty("lastError");
					expect(resumed?.metadata).not.toHaveProperty("baseInterval");
				} finally {
					finishWorker.release();
					releaseSnapshot.release();
					await Promise.allSettled(pending);
					runtime.getTask = originalGetTask;
					await cleanup();
				}
			}, 120_000);
		}
	}
});
