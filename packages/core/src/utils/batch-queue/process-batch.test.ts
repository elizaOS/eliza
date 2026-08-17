/**
 * Exercises the opt-in `processBatch` path on BatchQueue that lets the
 * embedding-drain embed N texts in one request. Per-item callers (no
 * `processBatch`) are unaffected; with it set, a drain calls it ONCE and only
 * falls back to the per-item `process` if the batched call throws.
 */

import { describe, expect, test } from "vitest";
import { BatchQueue } from "./index";

describe("BatchQueue processBatch", () => {
	function makeQueue(opts: {
		process: (item: number) => Promise<void>;
		processBatch?: (
			items: number[],
		) => Promise<{ item: number; success: boolean; retryCount: number }[]>;
	}) {
		return new BatchQueue<number>({
			name: "TEST_DRAIN",
			batchSize: 10,
			drainIntervalMs: 100,
			getPriority: () => "normal",
			maxParallel: 5,
			process: opts.process,
			processBatch: opts.processBatch,
		});
	}

	test("a drain calls processBatch ONCE with the whole slice, not process per-item", async () => {
		const perItem: number[] = [];
		const batched: number[][] = [];
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
			processBatch: async (items) => {
				batched.push([...items]);
				return items.map((item) => ({ item, success: true, retryCount: 0 }));
			},
		});

		q.enqueue(1);
		q.enqueue(2);
		q.enqueue(3);
		await q.drain();

		// One batched call for all three; the per-item path never ran.
		expect(batched).toEqual([[1, 2, 3]]);
		expect(perItem).toEqual([]);
	});

	test("a batch-wide failure falls back to the per-item process path", async () => {
		const perItem: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
			processBatch: async () => {
				throw new Error("batch endpoint down");
			},
		});

		q.enqueue(1);
		q.enqueue(2);
		await q.drain();

		// processBatch threw -> every item was processed individually (retry path).
		expect(perItem.sort()).toEqual([1, 2]);
	});

	test("without processBatch, behavior is unchanged (per-item only)", async () => {
		const perItem: number[] = [];
		const q = makeQueue({
			process: async (item) => {
				perItem.push(item);
			},
		});

		q.enqueue(7);
		q.enqueue(8);
		await q.drain();

		expect(perItem.sort()).toEqual([7, 8]);
	});
});

describe("BatchQueue low-priority yield boundary", () => {
	type Item = { id: string; priority: "high" | "normal" | "low" };

	test("claims one low item and lets newly arrived high work preempt the backlog", async () => {
		const processed: string[] = [];
		let queue: BatchQueue<Item>;
		queue = new BatchQueue<Item>({
			name: "PREEMPTIBLE_LOW_DRAIN",
			batchSize: 10,
			lowPriorityBatchSize: 1,
			drainIntervalMs: 100,
			getPriority: (item) => item.priority,
			maxParallel: 10,
			process: async (item) => {
				processed.push(item.id);
				if (item.id === "low-1") {
					queue.enqueue({ id: "high-live", priority: "high" });
				}
			},
		});
		queue.enqueue({ id: "low-1", priority: "low" });
		queue.enqueue({ id: "low-2", priority: "low" });
		queue.enqueue({ id: "low-3", priority: "low" });

		await queue.drain();
		expect(processed).toEqual(["low-1"]);
		expect(queue.size).toBe(3);

		await queue.drain();
		expect(processed).toEqual(["low-1", "high-live"]);
		expect(queue.size).toBe(2);
	});

	test("keeps the configured batch throughput for high and normal work", async () => {
		const batches: string[][] = [];
		const queue = new BatchQueue<Item>({
			name: "FOREGROUND_BATCH_DRAIN",
			batchSize: 10,
			lowPriorityBatchSize: 1,
			drainIntervalMs: 100,
			getPriority: (item) => item.priority,
			process: async () => {},
			processBatch: async (items) => {
				batches.push(items.map((item) => item.id));
				return items.map((item) => ({ item, success: true, retryCount: 0 }));
			},
		});
		queue.enqueue({ id: "normal-1", priority: "normal" });
		queue.enqueue({ id: "high-1", priority: "high" });
		queue.enqueue({ id: "normal-2", priority: "normal" });
		queue.enqueue({ id: "low-background", priority: "low" });

		await queue.drain();

		expect(batches).toEqual([["high-1", "normal-1", "normal-2"]]);
		expect(queue.size).toBe(1);
	});
});
