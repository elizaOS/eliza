import { expect, test, vi } from "vitest";
import { BatchQueue } from "../src/utils/batch-queue";

vi.mock("../src/logger.js", () => ({
	logger: {
		warn: () => {},
		error: () => {},
		info: () => {},
		debug: () => {},
	},
}));

function makeQueue(
	processBatch: (
		items: string[],
	) => Promise<Array<{ item: string; success: boolean; retryCount: number }>>,
	hooks: {
		processed?: string[];
		exhausted?: string[];
		outcomes?: Array<{ item: string; success: boolean }>;
	} = {},
) {
	const processed = hooks.processed ?? [];
	const exhausted = hooks.exhausted ?? [];
	const outcomes = hooks.outcomes ?? [];
	return {
		queue: new BatchQueue<string>({
			name: "TEST",
			batchSize: 3,
			drainIntervalMs: 60_000,
			getPriority: () => "normal",
			process: async (item) => {
				processed.push(item);
			},
			processBatch,
			onExhausted: (item) => {
				exhausted.push(item);
			},
			onDrainBatchOutcomes: (batchOutcomes) => {
				outcomes.push(
					...batchOutcomes.map((outcome) => ({
						item: outcome.item,
						success: outcome.success,
					})),
				);
			},
		}),
		processed,
		exhausted,
		outcomes,
	};
}

test("short processBatch array retries the unreported items instead of dropping them", async () => {
	const { queue, processed, exhausted, outcomes } = makeQueue(async (items) => [
		{ item: items[0], success: true, retryCount: 0 },
	]);
	queue.enqueue("a");
	queue.enqueue("b");
	queue.enqueue("c");
	expect(await queue.drain()).toBe(3);
	expect(queue.size).toBe(0);
	// b and c were dequeued but never reported: they must go through the
	// per-item retry path, not vanish.
	expect(processed).toEqual(["b", "c"]);
	expect(exhausted).toEqual([]);
	expect(outcomes).toEqual([
		{ item: "a", success: true },
		{ item: "b", success: true },
		{ item: "c", success: true },
	]);
});

test("empty processBatch array retries every item per-item", async () => {
	const { queue, processed, outcomes } = makeQueue(async () => []);
	queue.enqueue("a");
	queue.enqueue("b");
	expect(await queue.drain()).toBe(2);
	expect(processed).toEqual(["a", "b"]);
	expect(outcomes).toEqual([
		{ item: "a", success: true },
		{ item: "b", success: true },
	]);
});

test("extra processBatch outcomes for items never enqueued are ignored", async () => {
	const { queue, processed, outcomes } = makeQueue(async (items) => [
		{ item: items[0], success: true, retryCount: 0 },
		{ item: items[1], success: true, retryCount: 0 },
		{ item: items[2], success: true, retryCount: 0 },
		{ item: "foreign", success: false, retryCount: 0 },
	]);
	queue.enqueue("a");
	queue.enqueue("b");
	queue.enqueue("c");
	expect(await queue.drain()).toBe(3);
	expect(processed).toEqual([]);
	expect(outcomes).toEqual([
		{ item: "a", success: true },
		{ item: "b", success: true },
		{ item: "c", success: true },
	]);
});
