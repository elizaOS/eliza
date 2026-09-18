/**
 * Exercises vector persistence when a model becomes available after the embedding
 * service starts, using the real runtime registry, event bus, queue and adapter.
 */

import { InMemoryDatabaseAdapter } from "@elizaos/testing/in-memory-adapter";
import { expect, test } from "vitest";
import { createCharacter } from "../character";
import { AgentRuntime } from "../runtime";
import { EventType } from "../types/events";
import { ModelType } from "../types/model";
import { EmbeddingGenerationService } from "./embedding";

test.each([ModelType.TEXT_EMBEDDING, ModelType.TEXT_EMBEDDING_BATCH])(
	"persists a new memory after late %s registration and detaches on stop",
	async (modelType) => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = new AgentRuntime({
			character: createCharacter({ name: "Late embedding registration" }),
			adapter,
			logLevel: "fatal",
			enableAutonomy: false,
		});
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		const memory = {
			id: "976d2f6c-603c-4e2f-b04c-c358f08e483e" as const,
			entityId: runtime.agentId,
			roomId: runtime.agentId,
			content: { text: "The launch verification phrase is COPPER-FINCH-684." },
		};
		let calls = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const vector = Array.from({ length: 384 }, (_, i) => (i + 1) / 384);
		try {
			await runtime.createMemory(memory, "messages");
			runtime.registerModel(
				ModelType.TEXT_SMALL,
				async () => "unrelated",
				"test",
			);
			expect(
				runtime.getEvent(EventType.EMBEDDING_GENERATION_REQUESTED) ?? [],
			).toHaveLength(0);
			const embed = async () => {
				calls++;
				await gate;
				return modelType === ModelType.TEXT_EMBEDDING_BATCH ? [vector] : vector;
			};
			runtime.registerModel(modelType, embed, "test");
			// Registration events overlap while the first drain task is created.
			runtime.registerModel(modelType, embed, "second-provider");
			await expect
				.poll(
					() =>
						runtime.getEvent(EventType.EMBEDDING_GENERATION_REQUESTED)?.length,
				)
				.toBe(1);
			await runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime,
				memory,
				priority: "high",
			});
			const tasks = await runtime.getTasksByName("EMBEDDING_DRAIN");
			expect(tasks).toHaveLength(1);
			const worker = runtime.getTaskWorker("EMBEDDING_DRAIN");
			if (!worker || !tasks[0])
				throw new Error("Embedding drain was not registered");
			// The same durable source can arrive again before or during indexing.
			await runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime,
				memory: structuredClone(memory),
				priority: "high",
			});
			expect(service.getQueueSize()).toBe(1);
			const drain = worker.execute(runtime, {}, tasks[0]);
			await expect.poll(() => calls).toBe(1);
			await runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime,
				memory: structuredClone(memory),
				priority: "high",
			});
			expect(service.getQueueSize()).toBe(0);
			release();
			await drain;
			await worker.execute(runtime, {}, tasks[0]);
			await service.stop();
			expect((await runtime.getMemoryById(memory.id))?.embedding).toEqual(
				vector,
			);
			expect(calls).toBe(1);
			expect(
				runtime.getEvent(EventType.EMBEDDING_GENERATION_REQUESTED) ?? [],
			).toHaveLength(0);
			expect(runtime.getEvent(EventType.MODEL_REGISTERED) ?? []).toHaveLength(
				0,
			);
			runtime.registerModel(modelType, async () => vector, "replacement");
			await runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime,
				memory,
				priority: "high",
			});
			expect(calls).toBe(1);
			expect(service.getQueueSize()).toBe(0);
		} finally {
			release();
			await service.stop();
			await runtime.close();
		}
	},
);

test("a stopped waiting service never activates when a provider arrives", async () => {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "Stopped embedding waiter" }),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	const service = await EmbeddingGenerationService.start(runtime);
	try {
		await service.stop();
		runtime.registerModel(ModelType.TEXT_EMBEDDING, async () => [1], "late");
		expect(
			runtime.getEvent(EventType.EMBEDDING_GENERATION_REQUESTED) ?? [],
		).toHaveLength(0);
		expect(await runtime.getTasksByName("EMBEDDING_DRAIN")).toHaveLength(0);
	} finally {
		await service.stop();
		await runtime.close();
	}
});

// Controlled inference delays exercise the real queue, runtime and adapter.
// Provider numerical accuracy is covered by the separate native BGE proof.
test.each([
	[ModelType.TEXT_EMBEDDING, "edit"],
	[ModelType.TEXT_EMBEDDING, "delete"],
	[ModelType.TEXT_EMBEDDING_BATCH, "edit"],
	[ModelType.TEXT_EMBEDDING_BATCH, "delete"],
] as const)(
	"discards late %s results after source %s without retry or completion",
	async (modelType, mutation) => {
		const runtime = new AgentRuntime({
			character: createCharacter({ name: "Source race" }),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
			enableAutonomy: false,
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0,
			completions = 0;
		const oldVector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
		const newVector = Array.from({ length: 384 }, (_, i) => (i === 1 ? 1 : 0));
		runtime.registerModel(
			modelType,
			async () => {
				calls++;
				await gate;
				return modelType === ModelType.TEXT_EMBEDDING_BATCH
					? [oldVector]
					: oldVector;
			},
			"controlled-inference",
		);
		const service = (await EmbeddingGenerationService.start(
			runtime,
		)) as EmbeddingGenerationService;
		const memory = {
			id: "976d2f6c-603c-4e2f-b04c-c358f08e483e" as const,
			agentId: runtime.agentId,
			entityId: runtime.agentId,
			roomId: runtime.agentId,
			content: { text: "Original source" },
		};
		runtime.registerEvent(
			EventType.EMBEDDING_GENERATION_COMPLETED,
			async () => {
				completions++;
			},
		);
		try {
			await runtime.createMemory(memory, "messages");
			await runtime.emitEvent(EventType.EMBEDDING_GENERATION_REQUESTED, {
				runtime,
				memory,
				priority: "high",
			});
			const tasks = await runtime.getTasksByName("EMBEDDING_DRAIN");
			const worker = runtime.getTaskWorker("EMBEDDING_DRAIN");
			if (!worker || !tasks[0]) throw new Error("Missing drain worker");
			const drain = worker.execute(runtime, {}, tasks[0]);
			await expect.poll(() => calls).toBe(1);
			if (mutation === "edit") {
				await runtime.updateMemory({
					id: memory.id,
					content: { text: "Corrected source" },
					embedding: newVector,
				});
				// Event producers may reuse/mutate their object; inference still owns old bytes.
				memory.content.text = "Corrected source";
			} else await runtime.deleteMemory(memory.id);
			release();
			await drain;
			await worker.execute(runtime, {}, tasks[0]);
			const persisted = await runtime.getMemoryById(memory.id);
			if (mutation === "edit")
				expect(persisted).toMatchObject({
					content: { text: "Corrected source" },
					embedding: newVector,
				});
			else expect(persisted).toBeNull();
			expect(calls).toBe(1);
			expect(completions).toBe(0);
			expect(service.getQueueSize()).toBe(0);
		} finally {
			release();
			await service.stop();
			await runtime.close();
		}
	},
);
