/**
 * Deterministic unit coverage for the composed {@link BatchQueue} class in
 * index.ts: lifecycle guards around enqueue/drain/clear, batchSize clamping,
 * drain-hook isolation, and dispose shutdown-flush routing. The layered pieces
 * (PriorityQueue, BatchProcessor, TaskDrain) have their own suites; these cases
 * drive only what the composition adds on top of them, against the real module
 * with no mocks of the subject under test.
 */
import { describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import {
	type BatchItemOutcome,
	BatchQueue,
	type BatchQueueOptions,
} from "./index";
import type { QueuePriority } from "./priority-queue";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

type Item = { id: string; priority: QueuePriority };

function item(id: string, priority: QueuePriority = "normal"): Item {
	return { id, priority };
}

function makeQueue(
	options: Partial<BatchQueueOptions<Item>> = {},
): BatchQueue<Item> {
	return new BatchQueue<Item>({
		name: "TEST_DRAIN",
		batchSize: 10,
		drainIntervalMs: 100,
		getPriority: (queued) => queued.priority,
		process: async () => {},
		...options,
	});
}

describe("BatchQueue", () => {
	test("draining an empty queue processes nothing and fires no hooks", async () => {
		const processed: Item[] = [];
		const outcomesSeen: BatchItemOutcome<Item>[][] = [];
		const completions: unknown[] = [];
		const queue = makeQueue({
			process: async (queued) => {
				processed.push(queued);
			},
			onDrainBatchOutcomes: (outcomes) => {
				outcomesSeen.push(outcomes);
			},
			onDrainComplete: (stats) => {
				completions.push(stats);
			},
		});

		await queue.drain();

		expect(processed).toEqual([]);
		expect(outcomesSeen).toEqual([]);
		expect(completions).toEqual([]);
	});

	test("clamps a non-positive batchSize so each drain still dequeues one item", async () => {
		const processed: string[] = [];
		const queue = makeQueue({
			batchSize: 0,
			process: async (queued) => {
				processed.push(queued.id);
			},
		});
		queue.enqueue(item("first"));
		queue.enqueue(item("second"));

		await queue.drain();
		expect(processed).toEqual(["first"]);

		await queue.drain();
		expect(processed).toEqual(["first", "second"]);
	});

	test("drains high-priority items before normal ones through the composition", async () => {
		const processed: string[] = [];
		const queue = makeQueue({
			process: async (queued) => {
				processed.push(queued.id);
			},
		});
		queue.enqueue(item("normal-first"));
		queue.enqueue(item("urgent", "high"));

		await queue.drain();
		expect(processed).toEqual(["urgent", "normal-first"]);
		expect(queue.size).toBe(0);
	});

	test("onDrainComplete reports consumed batchSize and remaining across drains", async () => {
		const stats: Array<{ batchSize: number; remaining: number }> = [];
		const durations: number[] = [];
		const queue = makeQueue({
			batchSize: 2,
			onDrainComplete: (drainStats) => {
				stats.push({
					batchSize: drainStats.batchSize,
					remaining: drainStats.remaining,
				});
				durations.push(drainStats.durationMs);
			},
		});
		queue.enqueue(item("n1"));
		queue.enqueue(item("n2"));
		queue.enqueue(item("n3"));

		await queue.drain();
		await queue.drain();

		expect(stats).toEqual([
			{ batchSize: 2, remaining: 1 },
			{ batchSize: 1, remaining: 0 },
		]);
		for (const durationMs of durations) {
			expect(typeof durationMs).toBe("number");
			expect(durationMs).toBeGreaterThanOrEqual(0);
		}
	});

	test("skips re-entrant drains while one is still running", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const processed: string[] = [];
		const queue = makeQueue({
			batchSize: 1,
			process: async (queued) => {
				processed.push(queued.id);
				if (queued.id === "held") {
					await gate;
				}
			},
		});
		queue.enqueue(item("held"));
		queue.enqueue(item("waiting"));

		const first = queue.drain();
		const second = queue.drain();
		release();
		await Promise.all([first, second]);

		// The overlapping drain was refused, so "waiting" was never pulled.
		expect(processed).toEqual(["held"]);
		expect(queue.size).toBe(1);

		await queue.drain();
		expect(processed).toEqual(["held", "waiting"]);
	});

	test("onDrainBatchOutcomes observes per-item outcomes on the default path", async () => {
		const seen: Array<Array<[string, boolean]>> = [];
		const queue = makeQueue({
			process: async (queued) => {
				if (queued.id === "bad") {
					throw new Error("item blew up");
				}
			},
			shouldRetry: () => false,
			onDrainBatchOutcomes: (outcomes) => {
				seen.push(
					outcomes.map((outcome) => [outcome.item.id, outcome.success]),
				);
			},
		});
		queue.enqueue(item("good"));
		queue.enqueue(item("bad"));

		await queue.drain();
		expect(seen).toEqual([
			[
				["good", true],
				["bad", false],
			],
		]);
	});

	test("hook failures do not fail an already-completed drain", async () => {
		let completionCalls = 0;
		const processed: string[] = [];
		const queue = makeQueue({
			process: async (queued) => {
				processed.push(queued.id);
			},
			onDrainBatchOutcomes: () => {
				throw new Error("observer exploded");
			},
			onDrainComplete: () => {
				completionCalls += 1;
				throw new Error("completion observer exploded");
			},
		});
		queue.enqueue(item("survivor"));

		await expect(queue.drain()).resolves.toBeUndefined();
		expect(processed).toEqual(["survivor"]);
		expect(completionCalls).toBe(1);
	});

	test("clear empties the queue and later enqueues start fresh", () => {
		const queue = makeQueue();
		queue.enqueue(item("a", "high"));
		queue.enqueue(item("b"));

		queue.clear();
		expect(queue.size).toBe(0);
		expect(queue.stats().total).toBe(0);

		expect(queue.enqueue(item("c"))).toBe(true);
		expect(queue.stats().total).toBe(1);
	});

	describe("dispose", () => {
		test("makes enqueue, drain, and clear inert after disposal", async () => {
			const processed: string[] = [];
			const queue = makeQueue({
				process: async (queued) => {
					processed.push(queued.id);
				},
			});
			queue.enqueue(item("pending"));
			await queue.dispose(createMockRuntime({ agentId: AGENT_ID }), {
				flushHighPriority: false,
			});

			expect(queue.size).toBe(0);
			expect(queue.enqueue(item("late"))).toBe(false);
			await expect(queue.drain()).resolves.toBeUndefined();
			queue.clear();
			expect(queue.size).toBe(0);
			expect(processed).toEqual([]);
		});

		test("start on a disposed queue rejects instead of registering a worker", async () => {
			const queue = makeQueue();
			await queue.dispose(createMockRuntime({ agentId: AGENT_ID }), {
				flushHighPriority: false,
			});

			await expect(
				queue.start(createMockRuntime({ agentId: AGENT_ID })),
			).rejects.toThrow('BatchQueue "TEST_DRAIN" has already been disposed');
		});

		test("default flush runs only high items once each through the processor", async () => {
			const processed: string[] = [];
			const attempts: string[] = [];
			const exhausted: Array<{ id: string; message: string }> = [];
			const flushed: Array<Array<[string, boolean]>> = [];
			const queue = makeQueue({
				process: async (queued) => {
					attempts.push(queued.id);
					if (queued.id === "hot") {
						throw new Error("flush target down");
					}
					processed.push(queued.id);
				},
				onExhausted: (failed, error) => {
					exhausted.push({ id: failed.id, message: error.message });
				},
				onDrainBatchOutcomes: (outcomes) => {
					flushed.push(
						outcomes.map((outcome) => [outcome.item.id, outcome.success]),
					);
				},
			});
			queue.enqueue(item("cold-low", "low"));
			queue.enqueue(item("hot", "high"));
			queue.enqueue(item("warm"));

			await queue.dispose(createMockRuntime({ agentId: AGENT_ID }));

			// Only the high item ran, exactly once (single attempt, no retry tail).
			expect(attempts).toEqual(["hot"]);
			expect(processed).toEqual([]);
			expect(exhausted).toEqual([{ id: "hot", message: "flush target down" }]);
			expect(flushed).toEqual([[["hot", false]]]);
			expect(queue.size).toBe(0);
		});

		test("legacy flush loop reports per-item failures to the runtime", async () => {
			const reportError = vi.fn();
			const processed: string[] = [];
			const attempts: string[] = [];
			const flushError = new Error("legacy flush down");
			const queue = makeQueue({
				disposeHighPriorityViaProcessor: false,
				process: async (queued) => {
					attempts.push(queued.id);
					if (queued.id === "hot") {
						throw flushError;
					}
					processed.push(queued.id);
				},
			});
			queue.enqueue(item("warm"));
			queue.enqueue(item("hot", "high"));
			const runtime = createMockRuntime({ agentId: AGENT_ID, reportError });

			await queue.dispose(runtime);

			// The legacy loop flushes high items only; normal items are never
			// attempted during shutdown, and the failure is reported, not thrown.
			expect(attempts).toEqual(["hot"]);
			expect(processed).toEqual([]);
			expect(reportError).toHaveBeenCalledTimes(1);
			expect(reportError).toHaveBeenCalledWith(
				"BatchQueue.shutdownFlush",
				flushError,
				{ queue: "TEST_DRAIN" },
			);
			expect(queue.size).toBe(0);
		});

		test("drainHighPriorityOnStop false skips the shutdown flush entirely", async () => {
			const processed: string[] = [];
			const queue = makeQueue({
				drainHighPriorityOnStop: false,
				process: async (queued) => {
					processed.push(queued.id);
				},
			});
			queue.enqueue(item("urgent", "high"));

			await queue.dispose(createMockRuntime({ agentId: AGENT_ID }));

			expect(processed).toEqual([]);
			expect(queue.size).toBe(0);
		});

		test("flushHighPriority option overrides drainHighPriorityOnStop false", async () => {
			const processed: string[] = [];
			const queue = makeQueue({
				drainHighPriorityOnStop: false,
				process: async (queued) => {
					processed.push(queued.id);
				},
			});
			queue.enqueue(item("urgent", "high"));
			queue.enqueue(item("calm"));

			await queue.dispose(createMockRuntime({ agentId: AGENT_ID }), {
				flushHighPriority: true,
			});

			expect(processed).toEqual(["urgent"]);
			expect(queue.size).toBe(0);
		});
	});
});
