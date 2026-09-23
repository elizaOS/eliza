/**
 * Exercises the opt-in `processBatch` path on BatchQueue that lets the
 * embedding-drain embed N texts in one request. Per-item callers (no
 * `processBatch`) are unaffected; with it set, a drain calls it ONCE and only
 * falls back to the per-item `process` if the batched call throws.
 */

import { ElizaError } from "@elizaos/common";
import { describe, expect, test, vi } from "vitest";
import { isModelFundingAuthorityError } from "../model-errors";
import { BatchQueue } from "./index";

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
});
