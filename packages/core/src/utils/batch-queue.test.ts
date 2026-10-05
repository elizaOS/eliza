/**
 * Exercises the opt-in `processBatch` path on BatchQueue that lets the
 * embedding-drain embed N texts in one request. Per-item callers (no
 * `processBatch`) are unaffected; with it set, a drain calls it ONCE and routes
 * batch-wide throws and explicit failed item outcomes through per-item retries.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import { BatchQueue } from "./batch-queue";
import { isModelFundingAuthorityError } from "./model-errors";

describe("BatchQueue processBatch", () => {
	test("a failed funded batch cannot become new per-item purchases", async () => {
		const failure = new ElizaError("Recover original funded batch", {
			code: "MODEL_FUNDING_AUTHORITY_FAILED",
		});
		const process = vi.fn(async (_item: number) => {});
		const exhausted = vi.fn(async (_item: number, _error: Error) => {});
		const q = new BatchQueue<number>({
			name: "FUNDED_DRAIN",
			batchSize: 10,
			drainIntervalMs: 100,
			getPriority: () => "normal",
			process,
			processBatch: async () => {
				throw failure;
			},
			shouldRetry: (_item, error) => !isModelFundingAuthorityError(error),
			onExhausted: exhausted,
		});
		q.enqueue(1);
		q.enqueue(2);
		await q.drain();
		await q.drain();
		expect(process).not.toHaveBeenCalled();
		expect(exhausted.mock.calls).toEqual([
			[1, failure],
			[2, failure],
		]);
	});

	test("failed item outcomes are retried per item, in batch order", async () => {
		const fatal = new Error("fatal");
		const process = vi.fn(async (item: number) => {
			if (item === 3) throw new Error("still failing");
		});
		const exhausted = vi.fn(async (_item: number, _error: Error) => {});
		const seen: Array<{ item: number; success: boolean; retryCount: number }> =
			[];
		const q = new BatchQueue<number>({
			name: "PARTIAL_DRAIN",
			batchSize: 10,
			drainIntervalMs: 100,
			getPriority: () => "normal",
			maxRetriesAfterFailure: 1,
			retryPolicy: { minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
			process,
			processBatch: async (items) =>
				items.map((item) =>
					item === 1
						? { item, success: true, retryCount: 0 }
						: {
								item,
								success: false,
								error: item === 4 ? fatal : new Error("batch item failed"),
								retryCount: 0,
							},
				),
			shouldRetry: (_item, error) => error !== fatal,
			onExhausted: exhausted,
			onDrainBatchOutcomes: (outcomes) => {
				seen.push(...outcomes);
			},
		});
		for (const item of [1, 2, 3, 4]) q.enqueue(item);
		await q.drain();
		expect(process.mock.calls.map(([item]) => item)).toEqual([2, 3, 3]);
		expect(exhausted.mock.calls.map(([item]) => item)).toEqual([4, 3]);
		expect(seen).toMatchObject([
			{ item: 1, success: true, retryCount: 0 },
			{ item: 2, success: true, retryCount: 0 },
			{ item: 3, success: false, retryCount: 1 },
			{ item: 4, success: false, retryCount: 0 },
		]);
	});
});
