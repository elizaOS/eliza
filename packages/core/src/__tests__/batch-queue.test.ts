import { describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";
import type { IAgentRuntime } from "../types/runtime";
import { BatchProcessor } from "../utils/batch-queue/batch-processor";
import { BatchQueue } from "../utils/batch-queue/index";
import type { QueuePriority } from "../utils/batch-queue/priority-queue";
import { PriorityQueue } from "../utils/batch-queue/priority-queue";
import { Semaphore } from "../utils/batch-queue/semaphore";

describe("PriorityQueue", () => {
	it("orders high before normal before low", () => {
		const q = new PriorityQueue<{ id: number; p: "high" | "normal" | "low" }>({
			getPriority: (x) => x.p,
		});
		q.enqueue({ id: 1, p: "low" });
		q.enqueue({ id: 2, p: "high" });
		q.enqueue({ id: 3, p: "normal" });
		const batch = q.dequeueBatch(10);
		expect(batch.map((x) => x.id)).toEqual([2, 3, 1]);
	});

	it("rejects enqueue when onPressure returns false", () => {
		const q = new PriorityQueue<{ id: number; p: "high" | "normal" | "low" }>({
			getPriority: (x) => x.p,
			maxSize: 1,
			onPressure: () => false,
		});
		expect(q.enqueue({ id: 1, p: "high" })).toBe(true);
		expect(q.enqueue({ id: 2, p: "high" })).toBe(false);
		expect(q.size).toBe(1);
	});

	it("stats counts priorities", () => {
		const q = new PriorityQueue<{ id: number; p: "high" | "normal" | "low" }>({
			getPriority: (x) => x.p,
		});
		q.enqueue({ id: 1, p: "high" });
		q.enqueue({ id: 2, p: "normal" });
		q.enqueue({ id: 3, p: "low" });
		expect(q.stats()).toEqual({ high: 1, normal: 1, low: 1, total: 3 });
	});

	it("warns once and treats unknown priority labels as normal", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const q = new PriorityQueue<{ id: number; tag: string }>({
			getPriority: (x) => x.tag as QueuePriority,
		});
		q.enqueue({ id: 1, tag: "urgent" });
		q.enqueue({ id: 2, tag: "high" });
		const batch = q.dequeueBatch(10);
		expect(batch.map((x) => x.id)).toEqual([2, 1]);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe("BatchProcessor", () => {
	it("processes batch with concurrency limit", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const processor = new BatchProcessor<number>({
			maxParallel: 2,
			maxRetriesAfterFailure: 0,
			process: async (_n) => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, 5));
				concurrent--;
			},
		});
		await processor.processBatch([1, 2, 3, 4, 5]);
		expect(maxConcurrent).toBeLessThanOrEqual(2);
	});

	it("retries then succeeds", async () => {
		let calls = 0;
		const processor = new BatchProcessor<number>({
			maxParallel: 1,
			maxRetriesAfterFailure: 2,
			process: async (_n) => {
				calls++;
				if (calls < 2) {
					throw new Error("fail");
				}
			},
		});
		const out = await processor.processBatch([1]);
		expect(out[0]?.success).toBe(true);
		expect(calls).toBe(2);
	});

	it("calls onExhausted after max retries", async () => {
		const onExhausted = vi.fn();
		const processor = new BatchProcessor<number>({
			maxParallel: 1,
			maxRetriesAfterFailure: 1,
			process: async () => {
				throw new Error("always");
			},
			onExhausted,
		});
		const out = await processor.processBatch([42]);
		expect(out[0]?.success).toBe(false);
		expect(onExhausted).toHaveBeenCalled();
	});

	it("uses per-item _batchMaxAttempts (total tries)", async () => {
		type Item = { _batchMaxAttempts: number };
		let attempts = 0;
		const processor = new BatchProcessor<Item>({
			maxParallel: 1,
			maxRetriesAfterFailure: 0,
			process: async () => {
				attempts++;
				throw new Error("x");
			},
		});
		await processor.processBatch([{ _batchMaxAttempts: 3 }]);
		expect(attempts).toBe(3);
	});

	it("maxAttemptsCap overrides per-item _batchMaxAttempts", async () => {
		type Item = { _batchMaxAttempts: number };
		let attempts = 0;
		const processor = new BatchProcessor<Item>({
			maxParallel: 1,
			maxRetriesAfterFailure: 5,
			maxAttemptsCap: 1,
			process: async () => {
				attempts++;
				throw new Error("x");
			},
		});
		await processor.processBatch([{ _batchMaxAttempts: 99 }]);
		expect(attempts).toBe(1);
	});

	it("respects maxParallel under load", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		const processor = new BatchProcessor<number>({
			maxParallel: 3,
			maxRetriesAfterFailure: 0,
			process: async () => {
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await new Promise((r) => setTimeout(r, 3));
				concurrent--;
			},
		});
		await processor.processBatch(Array.from({ length: 30 }, (_, i) => i));
		expect(maxConcurrent).toBeLessThanOrEqual(3);
	});
});

describe("BatchQueue", () => {
	it("calls onDrainBatchOutcomes after a non-empty drain", async () => {
		const batches: unknown[] = [];
		const bq = new BatchQueue<number>({
			name: "TEST_BATCH_QUEUE_DRAIN",
			batchSize: 5,
			drainIntervalMs: 60_000,
			getPriority: () => "normal",
			process: async () => {},
			onDrainBatchOutcomes: (o) => batches.push(o),
		});
		bq.enqueue(7);
		await bq.drain();
		expect(batches).toHaveLength(1);
		const first = batches[0] as { length: number; 0: { success: boolean } };
		expect(first.length).toBe(1);
		expect(first[0].success).toBe(true);
	});

	it("dispose flush invokes onDrainBatchOutcomes via processor by default", async () => {
		const batches: unknown[] = [];
		const runtime = {
			agentId: "agent-1",
			deleteTask: vi.fn().mockResolvedValue(undefined),
		} as unknown as IAgentRuntime;
		const bq = new BatchQueue<number>({
			name: "TEST_FLUSH",
			batchSize: 2,
			drainIntervalMs: 60_000,
			getPriority: (n) => (n === 1 ? "high" : "normal"),
			process: async () => {},
			onDrainBatchOutcomes: (o) => batches.push(o),
		});
		bq.enqueue(1);
		bq.enqueue(2);
		await bq.dispose(runtime, { flushHighPriority: true });
		expect(batches).toHaveLength(1);
		expect((batches[0] as unknown[]).length).toBe(1);
	});
});

describe("Semaphore", () => {
	it("limits concurrency", async () => {
		const s = new Semaphore(2);
		let n = 0;
		await Promise.all(
			[1, 2, 3, 4].map(async () => {
				await s.acquire();
				n++;
				expect(n).toBeLessThanOrEqual(2);
				await new Promise((r) => setTimeout(r, 2));
				n--;
				s.release();
			}),
		);
	});
});
