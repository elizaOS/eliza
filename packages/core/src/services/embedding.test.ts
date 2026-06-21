import { describe, expect, test, vi } from "vitest";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { EmbeddingGenerationService } from "./embedding";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

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

describe("EmbeddingGenerationService drain config", () => {
	test("uses the per-item drain even when a batch embedding model is registered", async () => {
		const runtime = makeRuntime({ batch: true });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		// biome-ignore lint/suspicious/noExplicitAny: inspect the private queue config the service chose
		const queue = (service as any).batchQueue;
		expect(queue).toBeTruthy();
		expect(queue.options.drainIntervalMs).toBe(100);
		expect(queue.options.processBatch).toBeUndefined();

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
