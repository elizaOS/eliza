import { describe, expect, test, vi } from "vitest";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { EmbeddingGenerationService } from "./embedding";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Regression guard for #8829 (the "batch-of-1"): when a provider registers a
 * `TEXT_EMBEDDING_BATCH` handler, the embedding drain MUST run on the longer,
 * accumulating interval (~1s) so a turn's ~19 memories — which trickle in
 * ~250ms apart across the turn — pile up and embed in a few multi-text batch
 * calls. The original tight 100ms drained one-at-a-time (a batch of 1 per
 * drain → no real batching), which is exactly what slipped back in on a clean
 * image. When NO batch handler exists (e.g. local gte-small), the per-item
 * path keeps the tight 100ms and never wires `processBatch`.
 */
function makeRuntime(opts: { batch: boolean }): IAgentRuntime {
	const models: Record<string, unknown> = {
		[ModelType.TEXT_EMBEDDING]: () => Promise.resolve([0.1]),
	};
	if (opts.batch) {
		models[ModelType.TEXT_EMBEDDING_BATCH] = () => Promise.resolve([[0.1]]);
	}
	const noop = () => {};
	return {
		agentId: AGENT_ID,
		logger: { info: noop, warn: noop, debug: noop, error: noop },
		getModel: (type: string) => models[type],
		registerEvent: vi.fn(),
		registerTaskWorker: vi.fn(),
		getTasksByName: async () => [],
		getTask: async () => null,
		updateTask: async () => {},
		createTask: vi.fn(async () => AGENT_ID),
		deleteTask: vi.fn(async () => {}),
	} as unknown as IAgentRuntime;
}

describe("EmbeddingGenerationService drain config (#8829)", () => {
	test("with a TEXT_EMBEDDING_BATCH handler: accumulating drain (>=1s) + processBatch wired", async () => {
		const runtime = makeRuntime({ batch: true });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		// biome-ignore lint/suspicious/noExplicitAny: inspect the private queue config the service chose
		const queue = (service as any).batchQueue;
		expect(queue).toBeTruthy();
		// Must be long enough for a ~250ms trickle to accumulate — NOT the
		// batch-of-1 100ms. (Default is 1000ms; env-tunable.)
		expect(queue.options.drainIntervalMs).toBeGreaterThanOrEqual(1000);
		expect(typeof queue.options.processBatch).toBe("function");

		await service.stop();
	});

	test("without a batch handler: tight 100ms per-item drain, no processBatch", async () => {
		const runtime = makeRuntime({ batch: false });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		// biome-ignore lint/suspicious/noExplicitAny: inspect the private queue config the service chose
		const queue = (service as any).batchQueue;
		expect(queue.options.drainIntervalMs).toBe(100);
		expect(queue.options.processBatch).toBeUndefined();

		await service.stop();
	});
});
