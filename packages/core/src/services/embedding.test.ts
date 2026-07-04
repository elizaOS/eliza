/**
 * Exercises `EmbeddingGenerationService`: drain configuration (batch vs per-item,
 * fast-shutdown) and the `processBatch` path — one batch call with per-id
 * write-back, empty-vector and count-mismatch failure handling, and isolated
 * per-item fallback. Runs against a mock runtime with stubbed embedding models.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { ModelType } from "../types/model";
import type { IAgentRuntime } from "../types/runtime";
import { EmbeddingGenerationService } from "./embedding";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";

interface RuntimeMockOpts {
	batch: boolean;
	embedHandler?: (params: unknown) => Promise<unknown>;
	batchHandler?: (params: { texts: string[] }) => Promise<number[][]>;
	updateMemory?: (params: { id: string; embedding: number[] }) => Promise<void>;
}

function makeRuntime(opts: RuntimeMockOpts): IAgentRuntime {
	const models: Record<string, unknown> = {
		[ModelType.TEXT_EMBEDDING]:
			opts.embedHandler ?? (() => Promise.resolve([0.1])),
	};
	if (opts.batch) {
		models[ModelType.TEXT_EMBEDDING_BATCH] =
			opts.batchHandler ?? (() => Promise.resolve([[0.1]]));
	}
	const noop = () => {};
	return {
		agentId: AGENT_ID,
		logger: { info: noop, warn: noop, debug: noop, error: noop },
		getModel: (type: string) => models[type],
		useModel: (type: string, params: unknown) => {
			const handler = models[type] as
				| ((p: unknown) => Promise<unknown>)
				| undefined;
			if (!handler) {
				throw new Error(`No handler for ${type}`);
			}
			return handler(params);
		},
		updateMemory: opts.updateMemory ?? (async () => {}),
		log: async () => {},
		emitEvent: async () => {},
		registerEvent: vi.fn(),
		registerTaskWorker: vi.fn(),
		getTasksByName: async () => [],
		getTask: async () => null,
		updateTask: async () => {},
		createTask: vi.fn(async () => AGENT_ID),
		deleteTask: vi.fn(async () => {}),
	} as unknown as IAgentRuntime;
}

function makeItem(id: string, text: string | undefined) {
	return {
		memory: {
			id,
			roomId: AGENT_ID,
			content: text === undefined ? {} : { text },
		},
		priority: "normal" as const,
	};
}

describe("EmbeddingGenerationService drain config", () => {
	const previousFastShutdown = process.env.ELIZA_FAST_SHUTDOWN;

	afterEach(() => {
		if (previousFastShutdown === undefined) {
			delete process.env.ELIZA_FAST_SHUTDOWN;
		} else {
			process.env.ELIZA_FAST_SHUTDOWN = previousFastShutdown;
		}
	});

	test("wires processBatch when a TEXT_EMBEDDING_BATCH model is registered", async () => {
		const runtime = makeRuntime({ batch: true });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;

		// biome-ignore lint/suspicious/noExplicitAny: inspect the private queue config the service chose
		const queue = (service as any).batchQueue;
		expect(queue).toBeTruthy();
		expect(queue.options.drainIntervalMs).toBe(100);
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

	test("fast shutdown clears queued embeddings instead of flushing high-priority work", async () => {
		const updateMemory = vi.fn(async () => {});
		const runtime = makeRuntime({ batch: false, updateMemory });
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: exercise the private event handler directly
		await (service as any).handleEmbeddingRequest(
			makeItem("id-fast-stop", "queued text"),
		);
		expect(service.getQueueSize()).toBe(1);

		process.env.ELIZA_FAST_SHUTDOWN = "1";
		await service.stop();

		expect(service.getQueueSize()).toBe(0);
		expect(updateMemory).not.toHaveBeenCalled();
	});
});

describe("EmbeddingGenerationService processBatch", () => {
	test("batches multiple items into ONE TEXT_EMBEDDING_BATCH call and writes back per id", async () => {
		let batchCalls = 0;
		let lastTexts: string[] = [];
		const written: { id: string; embedding: number[] }[] = [];
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async ({ texts }) => {
				batchCalls++;
				lastTexts = texts;
				return texts.map((_, i) => [i, i + 1]);
			},
			updateMemory: async ({ id, embedding }) => {
				written.push({ id, embedding });
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ success: boolean }[]>;

		const items = [makeItem("id-a", "alpha"), makeItem("id-b", "beta")];
		const outcomes = await processBatch(items);

		expect(batchCalls).toBe(1);
		expect(lastTexts).toEqual(["alpha", "beta"]);
		expect(outcomes.every((o) => o.success)).toBe(true);
		// Per-id write-back: each memory got its own vector.
		expect(written).toEqual([
			{ id: "id-a", embedding: [0, 1] },
			{ id: "id-b", embedding: [1, 2] },
		]);

		await service.stop();
	});

	test("an empty vector in the batch is failed, not falsely succeeded or persisted", async () => {
		const written: { id: string; embedding: number[] }[] = [];
		const runtime = makeRuntime({
			batch: true,
			// Middle item comes back as an empty vector (malformed/partial batch).
			batchHandler: async ({ texts }) =>
				texts.map((_, i) => (i === 1 ? [] : [i, i + 1])),
			updateMemory: async ({ id, embedding }) => {
				written.push({ id, embedding });
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ item: { memory: { id: string } }; success: boolean }[]>;

		const items = [
			makeItem("id-a", "alpha"),
			makeItem("id-b", "beta"),
			makeItem("id-c", "gamma"),
		];
		const outcomes = await processBatch(items);

		const byId = new Map(outcomes.map((o) => [o.item.memory.id, o.success]));
		// The empty vector must NOT be reported as a successful embedding.
		expect(byId.get("id-b")).toBe(false);
		expect(byId.get("id-a")).toBe(true);
		expect(byId.get("id-c")).toBe(true);
		// And it must never be written back to the store.
		expect(written.map((w) => w.id).sort()).toEqual(["id-a", "id-c"]);

		await service.stop();
	});

	test("skips empty / already-embedded items but still embeds the rest in one call", async () => {
		let batchCalls = 0;
		let lastTexts: string[] = [];
		const written: string[] = [];
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async ({ texts }) => {
				batchCalls++;
				lastTexts = texts;
				return texts.map(() => [0.5]);
			},
			updateMemory: async ({ id }) => {
				written.push(id);
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ success: boolean }[]>;

		const alreadyEmbedded = makeItem("id-skip", "ignored");
		// biome-ignore lint/suspicious/noExplicitAny: set a pre-existing vector
		(alreadyEmbedded.memory as any).embedding = [9];
		const items = [
			makeItem("id-real", "real text"),
			makeItem("id-empty", undefined),
			alreadyEmbedded,
		];
		const outcomes = await processBatch(items);

		expect(batchCalls).toBe(1);
		expect(lastTexts).toEqual(["real text"]);
		// All three outcomes succeed (two skipped, one embedded); only the real
		// one is written back.
		expect(outcomes).toHaveLength(3);
		expect(outcomes.every((o) => o.success)).toBe(true);
		expect(written).toEqual(["id-real"]);

		await service.stop();
	});

	test("a batch-wide throw propagates so BatchQueue falls back to per-item process", async () => {
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async () => {
				throw new Error("batch endpoint down");
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<unknown>;

		// The throw must propagate; BatchQueue.drain catches it and runs the
		// per-item `process` path (preserving retry / onExhausted).
		await expect(processBatch([makeItem("id-a", "alpha")])).rejects.toThrow(
			"batch endpoint down",
		);

		await service.stop();
	});

	test("a vector/text count mismatch throws so the whole batch falls back per-item", async () => {
		const runtime = makeRuntime({
			batch: true,
			// Return fewer vectors than texts — unmappable to ids.
			batchHandler: async () => [[0.1]],
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<unknown>;

		await expect(
			processBatch([makeItem("id-a", "alpha"), makeItem("id-b", "beta")]),
		).rejects.toThrow(/TEXT_EMBEDDING_BATCH returned/);

		await service.stop();
	});

	test("a single id's write-back failure is isolated to that item, not the batch", async () => {
		const runtime = makeRuntime({
			batch: true,
			batchHandler: async ({ texts }) => texts.map(() => [0.3]),
			updateMemory: async ({ id }) => {
				if (id === "id-b") {
					throw new Error("db write failed for b");
				}
			},
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		// biome-ignore lint/suspicious/noExplicitAny: drive the private batch processor directly
		const processBatch = (service as any).batchQueue.options.processBatch as (
			items: unknown[],
		) => Promise<{ item: { memory: { id: string } }; success: boolean }[]>;

		const outcomes = await processBatch([
			makeItem("id-a", "alpha"),
			makeItem("id-b", "beta"),
		]);

		const byId = new Map(outcomes.map((o) => [o.item.memory.id, o.success]));
		expect(byId.get("id-a")).toBe(true);
		expect(byId.get("id-b")).toBe(false);

		await service.stop();
	});
});
