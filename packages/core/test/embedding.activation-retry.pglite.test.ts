/**
 * A failed late activation of the embedding service must be withdrawn, not
 * cached: the next MODEL_REGISTERED retries it, request handlers do not stack,
 * and teardown completes. Drives the real runtime, model registry, event bus,
 * task drain and in-memory PGlite adapter; only `createTask` is wrapped to
 * inject a transient task-store failure.
 */

import pluginSql from "@elizaos/plugin-sql";
import { describe, expect, it } from "vitest";
import { identifyEmbeddingVector } from "../src/embedding-vector-space";
import { AgentRuntime } from "../src/runtime";
import { EmbeddingGenerationService } from "../src/services/embedding";
import { EventType } from "../src/types/events";
import { ModelType } from "../src/types/model";

const DIMENSIONS = 384;
// Eighths survive pgvector's float32 storage exactly.
const vector = Array.from({ length: DIMENSIONS }, (_, i) => ((i % 8) + 1) / 8);

let databases = 0;

async function createRuntime(name: string): Promise<{
	runtime: AgentRuntime;
	cleanup: () => Promise<void>;
}> {
	const previousDataDir = process.env.PGLITE_DATA_DIR;
	// plugin-sql caches managers per data dir, so each runtime gets its own.
	process.env.PGLITE_DATA_DIR = `memory://embedding-activation-${process.pid}-${++databases}`;
	const runtime = new AgentRuntime({
		character: { name, bio: ["Tests embedding service activation"] },
		logLevel: "fatal",
	});
	await runtime.registerPlugin(pluginSql);
	await runtime.initialize();
	return {
		runtime,
		cleanup: async () => {
			await runtime.stop();
			await runtime.close();
			if (previousDataDir === undefined) delete process.env.PGLITE_DATA_DIR;
			else process.env.PGLITE_DATA_DIR = previousDataDir;
		},
	};
}

function registrationFailures(runtime: AgentRuntime) {
	return runtime
		.getRecentReportedErrors()
		.filter((report) => report.scope === "AgentRuntime.registerModel");
}

function handlerCount(runtime: AgentRuntime, event: string): number {
	return runtime.getEvent(event)?.length ?? 0;
}

describe("EmbeddingGenerationService late activation", () => {
	it("persists and retrieves a named vector after the model registers post-boot", async () => {
		const { runtime, cleanup } = await createRuntime("EmbeddingLateSuccess");
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		const memory = {
			id: "976d2f6c-603c-4e2f-b04c-c358f08e483e" as const,
			entityId: runtime.agentId,
			roomId: runtime.agentId,
			content: { text: "The launch verification phrase is COPPER-FINCH-684." },
		};
		let textCalls = 0;
		try {
			await runtime.createMemory(memory, "messages");
			runtime.registerModel(ModelType.TEXT_SMALL, async () => "x", "other");
			expect(
				handlerCount(runtime, EventType.EMBEDDING_GENERATION_REQUESTED),
			).toBe(0);
			// A provisioned Dedicated runtime installs its local embedder from a
			// plugin boot hook, after both runtime and service startup.
			runtime.registerModel(
				ModelType.TEXT_EMBEDDING,
				async (_runtime, params) => {
					if (params !== null) textCalls++;
					return identifyEmbeddingVector(
						params === null ? new Array(DIMENSIONS).fill(0) : [...vector],
						"test:late-local-384",
					);
				},
				"late-local",
			);
			await expect
				.poll(
					async () => (await runtime.getTasksByName("EMBEDDING_DRAIN")).length,
				)
				.toBe(1);
			await runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime,
				memory: (await runtime.getMemoryById(memory.id)) ?? memory,
				priority: "high",
			});
			const [task] = await runtime.getTasksByName("EMBEDDING_DRAIN");
			const worker = runtime.getTaskWorker("EMBEDDING_DRAIN");
			if (!worker || !task) throw new Error("Embedding drain not registered");
			await worker.execute(runtime, {}, task);
			await expect
				.poll(
					async () =>
						(await runtime.getMemoryById(memory.id))?.embedding?.length,
				)
				.toBe(DIMENSIONS);
			expect(textCalls).toBe(1);
			const [recalled] = await runtime.searchMemories({
				embedding: vector,
				tableName: "messages",
				count: 1,
			});
			expect(recalled?.id).toBe(memory.id);
		} finally {
			await service.stop();
			await cleanup();
		}
	});
});

describe("EmbeddingGenerationService late activation failure", () => {
	it("withdraws a failed activation so the next registration retries it", async () => {
		const { runtime, cleanup } = await createRuntime(
			"EmbeddingActivationRetry",
		);
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => {
			rejections.push(reason);
		};
		process.on("unhandledRejection", onRejection);
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		const originalCreateTask = runtime.createTask.bind(runtime);
		let createTaskCalls = 0;
		runtime.createTask = async (task) => {
			if (createTaskCalls++ === 0) {
				throw new Error("transient task-store outage");
			}
			return originalCreateTask(task);
		};
		const messageSentBaseline = handlerCount(runtime, EventType.MESSAGE_SENT);
		try {
			runtime.registerModel(
				ModelType.TEXT_EMBEDDING,
				async () => vector,
				"first",
			);
			await expect.poll(() => registrationFailures(runtime)).toHaveLength(1);
			expect(registrationFailures(runtime)[0]?.message).toContain(
				"transient task-store outage",
			);
			expect(await runtime.getTasksByName("EMBEDDING_DRAIN")).toHaveLength(0);
			expect(
				handlerCount(runtime, EventType.EMBEDDING_GENERATION_REQUESTED),
			).toBe(0);
			expect(handlerCount(runtime, EventType.MESSAGE_SENT)).toBe(
				messageSentBaseline,
			);

			runtime.registerModel(
				ModelType.TEXT_EMBEDDING,
				async () => vector,
				"second",
			);
			await expect
				.poll(
					async () => (await runtime.getTasksByName("EMBEDDING_DRAIN")).length,
				)
				.toBe(1);
			expect(
				handlerCount(runtime, EventType.EMBEDDING_GENERATION_REQUESTED),
			).toBe(1);
			expect(handlerCount(runtime, EventType.MESSAGE_SENT)).toBe(
				messageSentBaseline + 1,
			);

			expect(registrationFailures(runtime)).toHaveLength(1);

			await service.stop();
			await new Promise((resolve) => setImmediate(resolve));
			expect(rejections).toEqual([]);
		} finally {
			process.off("unhandledRejection", onRejection);
			await cleanup();
		}
	});

	it("completes teardown when stop races an activation that fails", async () => {
		const { runtime, cleanup } = await createRuntime("EmbeddingActivationStop");
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		let entered!: () => void;
		const createTaskEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let fail!: () => void;
		const failCreateTask = new Promise<void>((resolve) => {
			fail = resolve;
		});
		runtime.createTask = async () => {
			entered();
			await failCreateTask;
			throw new Error("task store went away during activation");
		};
		try {
			runtime.registerModel(
				ModelType.TEXT_EMBEDDING,
				async () => vector,
				"racing",
			);
			await createTaskEntered;
			const stopping = service.stop();
			fail();
			await expect(stopping).resolves.toBeUndefined();
			await expect.poll(() => registrationFailures(runtime)).toHaveLength(1);
			expect(
				handlerCount(runtime, EventType.EMBEDDING_GENERATION_REQUESTED),
			).toBe(0);
			expect(handlerCount(runtime, EventType.MODEL_REGISTERED)).toBe(0);
		} finally {
			fail();
			await cleanup();
		}
	});
});
