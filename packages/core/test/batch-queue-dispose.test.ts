/** A throwing outcome hook must not abort BatchQueue shutdown: drain() already
 * guards both hooks, but dispose() called the flush hook unguarded, so the
 * repeat task was never deleted and the queue never cleared. */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../src/types/runtime";
import { BatchQueue } from "../src/utils/batch-queue";

type Item = { id: string; priority: "high" | "normal" };

function stubRuntime(errors: string[]): IAgentRuntime {
	return {
		agentId: "00000000-0000-4000-8000-000000000001",
		registerTaskWorker() {},
		reportError(scope: string, error: unknown) {
			errors.push(
				`${scope}:${error instanceof Error ? error.message : String(error)}`,
			);
		},
	} as unknown as IAgentRuntime;
}

describe("BatchQueue.dispose", () => {
	it("completes shutdown when the flush outcome hook throws", async () => {
		const errors: string[] = [];
		const processed: string[] = [];
		const runtime = stubRuntime(errors);
		const queue = new BatchQueue<Item>({
			name: "TEST",
			batchSize: 5,
			drainIntervalMs: 1000,
			getPriority: (item) => item.priority,
			process: async (item) => {
				processed.push(item.id);
			},
			onDrainBatchOutcomes: () => {
				throw new Error("hook boom");
			},
		});
		queue.enqueue({ id: "high", priority: "high" });
		queue.enqueue({ id: "normal", priority: "normal" });
		await queue.start(runtime);

		await expect(
			queue.dispose(runtime, { flushHighPriority: true }),
		).resolves.toBeUndefined();

		expect(processed).toEqual(["high"]);
		expect(queue.size).toBe(0);
		expect(errors).toContain("BatchQueue.outcomeHook:hook boom");
	});
});
