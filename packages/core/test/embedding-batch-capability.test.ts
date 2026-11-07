/** Verifies live provider capability changes through the owning dispatch, service and queue. */
import { expect, test } from "vitest";
import { RuntimeModelDispatch } from "../src/runtime/model-dispatch";
import { EmbeddingGenerationService } from "../src/services/embedding";
import type { Memory } from "../src/types/memory";
import type { IAgentRuntime } from "../src/types/runtime";
import type { BatchQueue } from "../src/utils/batch-queue";

function harness(initialBatch: boolean, failBatch = false) {
	let pin: string | undefined = initialBatch ? undefined : "eliza-router",
		batch = 0,
		single = 0;
	const models = new Map<
		string,
		Array<{
			provider: string;
			handler: (
				runtime: unknown,
				params: Record<string, unknown>,
			) => Promise<number[] | number[][]>;
			priority: number;
		}>
	>();
	const singleHandler = async () => {
		single++;
		return [1, 0, 0];
	};
	const batchHandler = async (
		_rt: unknown,
		params: Record<string, unknown>,
	) => {
		batch++;
		if (failBatch) throw Error("actual provider batch failure");
		if (!Array.isArray(params.texts)) throw Error("Expected batch texts");
		return params.texts.map(() => [1, 0, 0]);
	};
	models.set("TEXT_EMBEDDING", [
		{ provider: "eliza-router", handler: singleHandler, priority: 100 },
	]);
	models.set("TEXT_EMBEDDING_BATCH", [
		{ provider: "elizacloud", handler: batchHandler, priority: 50 },
	]);
	let dispatch: RuntimeModelDispatch;
	const writes: string[] = [],
		errors: string[] = [],
		events: unknown[] = [];
	const runtime = {
		agentId: "00000000-0000-4000-8000-000000000001",
		logger: { info() {}, warn() {}, debug() {}, error() {} },
		registerEvent() {},
		unregisterEvent() {},
		registerTaskWorker() {},
		getSetting() {
			return undefined;
		},
		getModel(type: string) {
			return dispatch.getModel(type);
		},
		async useModel(type: string, params: Record<string, unknown>) {
			const handler = dispatch.getModel(type);
			if (!handler) {
				batch++;
				throw Error(`No handler found for delegate type: ${type}`);
			}
			return handler(
				runtime as unknown as IAgentRuntime,
				params as Parameters<typeof handler>[1],
			);
		},
		async updateMemoryEmbedding(params: {
			embedding: number[];
			expected: { text: string };
			id: string;
		}) {
			expect(params.embedding).toEqual([1, 0, 0]);
			expect(params.expected.text).toBe(`retained text ${params.id}`);
			writes.push(params.id);
			return true;
		},
		async log() {},
		async emitEvent(type: string, payload: unknown) {
			events.push({ type, payload });
		},
		reportError(scope: string, error: Error) {
			errors.push(`${scope}:${error.message}`);
		},
	};
	dispatch = new RuntimeModelDispatch(
		runtime as unknown as IAgentRuntime,
		{
			models: () => models,
			pinnedEmbeddingProvider: () => pin,
		} as unknown as ConstructorParameters<typeof RuntimeModelDispatch>[1],
	);
	return {
		runtime,
		writes,
		errors,
		events,
		setBatch(v: boolean) {
			pin = "eliza-router";
			if (v)
				models.set("TEXT_EMBEDDING_BATCH", [
					{ provider: "eliza-router", handler: batchHandler, priority: 50 },
				]);
		},
		counts() {
			return { batch, single };
		},
	};
}
function queueFor(service: EmbeddingGenerationService) {
	return (
		service as unknown as {
			batchQueue: BatchQueue<{ priority: "normal"; memory: Memory }>;
		}
	).batchQueue;
}
async function enqueueAndDrain(service: EmbeddingGenerationService, n: number) {
	const queue = queueFor(service);
	for (let i = 0; i < n; i++)
		queue.enqueue({
			priority: "normal",
			memory: {
				id: String(i),
				agentId: "00000000-0000-4000-8000-000000000001",
				entityId: "user",
				roomId: "room",
				content: { text: `retained text ${i}` },
			} as Memory,
		});
	return queue.drain();
}
test("batch capability withdrawn after initialization: singles persist every memory without false batch errors", async () => {
	const h = harness(true),
		service = (await EmbeddingGenerationService.start(
			h.runtime as unknown as IAgentRuntime,
		)) as EmbeddingGenerationService;
	h.setBatch(false);
	try {
		expect(await enqueueAndDrain(service, 10)).toBe(10);
		expect(h.counts()).toEqual({ batch: 0, single: 10 });
		expect(h.writes.length).toBe(10);
		expect(new Set(h.writes).size).toBe(10);
		expect(h.errors).toEqual([]);
	} finally {
		await service.stop();
	}
});
test("batch capability appears after initialization: use one batch and persist each result once", async () => {
	const h = harness(false),
		service = (await EmbeddingGenerationService.start(
			h.runtime as unknown as IAgentRuntime,
		)) as EmbeddingGenerationService;
	h.setBatch(true);
	try {
		expect(await enqueueAndDrain(service, 2)).toBe(2);
		expect(h.counts()).toEqual({ batch: 1, single: 0 });
		expect(h.writes).toEqual(["0", "1"]);
		expect(h.errors).toEqual([]);
	} finally {
		await service.stop();
	}
});
test("genuine registered batch failure stays observable and falls back per-item without duplicate writes", async () => {
	const h = harness(true, true),
		service = (await EmbeddingGenerationService.start(
			h.runtime as unknown as IAgentRuntime,
		)) as EmbeddingGenerationService;
	try {
		expect(await enqueueAndDrain(service, 2)).toBe(2);
		expect(h.counts()).toEqual({ batch: 1, single: 2 });
		expect(h.writes.length).toBe(2);
		expect(new Set(h.writes).size).toBe(2);
		expect(h.errors).toEqual([
			"BatchQueue.processBatch:actual provider batch failure",
		]);
	} finally {
		await service.stop();
	}
});

test("throwing capability probe leaves dequeued work intact for a later successful drain", async () => {
	const h = harness(true),
		service = (await EmbeddingGenerationService.start(
			h.runtime as unknown as IAgentRuntime,
		)) as EmbeddingGenerationService;
	const getModel = h.runtime.getModel.bind(h.runtime);
	h.runtime.getModel = () => {
		throw Error("registry unavailable");
	};
	const queue = queueFor(service);
	queue.enqueue({
		priority: "normal",
		memory: {
			id: "0",
			agentId: h.runtime.agentId,
			entityId: "user",
			roomId: "room",
			content: { text: "retained text 0" },
		} as Memory,
	});
	try {
		await expect(queue.drain()).rejects.toThrow("registry unavailable");
		expect(queue.size).toBe(1);
		expect(h.writes).toEqual([]);
		h.runtime.getModel = getModel;
		expect(await queue.drain()).toBe(1);
		expect(queue.size).toBe(0);
		expect(h.writes).toEqual(["0"]);
	} finally {
		h.runtime.getModel = getModel;
		await service.stop();
	}
});
