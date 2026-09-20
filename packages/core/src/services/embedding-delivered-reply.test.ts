import { expect, test, vi } from "vitest";
import { createCharacter } from "../character";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { EventType } from "../types/events";
import { ModelType } from "../types/model";
import { EmbeddingGenerationService } from "./embedding";

async function fixture() {
	const runtime = new AgentRuntime({
		character: createCharacter({ name: "Delivered reply indexing" }),
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
		enableAutonomy: false,
	});
	const embed = vi.fn(async () => Array.from({ length: 384 }, () => 0.1));
	runtime.registerModel(ModelType.TEXT_EMBEDDING, embed, "test");
	const service = (await EmbeddingGenerationService.start(
		runtime,
	)) as EmbeddingGenerationService;
	const memory = {
		id: "976d2f6c-603c-4e2f-b04c-c358f08e483e" as const,
		agentId: runtime.agentId,
		entityId: runtime.agentId,
		roomId: runtime.agentId,
		content: { text: "My earlier proposal was the copper notebook." },
	};
	return { runtime, service, memory, embed };
}
test("indexes a delivered persisted reply once through the background queue", async () => {
	const { runtime, service, memory, embed } = await fixture();
	try {
		await runtime.createMemory(memory, "messages");
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message: memory,
			source: "test",
		});
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message: memory,
			source: "test",
		});
		await expect.poll(() => service.getQueueSize()).toBe(1);
		expect(embed).not.toHaveBeenCalled();
		const tasks = await runtime.getTasksByName("EMBEDDING_DRAIN");
		const worker = runtime.getTaskWorker("EMBEDDING_DRAIN");
		if (!worker || !tasks[0]) throw new Error("Missing embedding worker");
		await worker.execute(runtime, {}, tasks[0]);
		expect(embed).toHaveBeenCalledTimes(1);
		const stored = await runtime.getMemoryById(memory.id);
		expect(stored?.embedding).toHaveLength(384);
		expect(stored?.entityId).toBe(runtime.agentId);
		expect(stored?.content.text).toBe(memory.content.text);
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message: memory,
			source: "test",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(service.getQueueSize()).toBe(0);
	} finally {
		await service.stop();
		await runtime.close();
	}
});
test("rejects missing, transient, foreign, and changed reply sources", async () => {
	const { runtime, service, memory } = await fixture();
	try {
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message: memory,
			source: "test",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(service.getQueueSize()).toBe(0);
		await runtime.createMemory(memory, "messages");
		for (const invalid of [
			{ ...memory, content: { ...memory.content, transient: true } },
			{ ...memory, content: { text: "not what was saved" } },
			{ ...memory, roomId: "a76d2f6c-603c-4e2f-b04c-c358f08e483e" as const },
			{ ...memory, entityId: "a76d2f6c-603c-4e2f-b04c-c358f08e483e" as const },
		])
			await runtime.emitEvent(EventType.MESSAGE_SENT, {
				runtime,
				message: invalid,
				source: "test",
			});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(service.getQueueSize()).toBe(0);
	} finally {
		await service.stop();
		await runtime.close();
	}
});
test("delivery does not await the lookup and stop cancels its pending admission", async () => {
	const { runtime, service, memory } = await fixture();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const original = runtime.getMemoryById.bind(runtime);
	try {
		await runtime.createMemory(memory, "messages");
		vi.spyOn(runtime, "getMemoryById").mockImplementation(async (id) => {
			await gate;
			return original(id);
		});
		await runtime.emitEvent(EventType.MESSAGE_SENT, {
			runtime,
			message: memory,
			source: "test",
		});
		expect(service.getQueueSize()).toBe(0);
		await service.stop();
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(service.getQueueSize()).toBe(0);
		expect(runtime.getEvent(EventType.MESSAGE_SENT) ?? []).toHaveLength(0);
	} finally {
		release();
		await service.stop();
		await runtime.close();
	}
});

test("reports detached lookup errors without failing delivery", async () => {
	const { runtime, service, memory } = await fixture();
	try {
		const failure = new Error("lookup unavailable");
		vi.spyOn(runtime, "getMemoryById").mockRejectedValue(failure);
		const report = vi
			.spyOn(runtime, "reportError")
			.mockImplementation(() => {});
		await expect(
			runtime.emitEvent(EventType.MESSAGE_SENT, {
				runtime,
				message: memory,
				source: "test",
			}),
		).resolves.toBeUndefined();
		await expect.poll(() => report.mock.calls.length).toBe(1);
		expect(report.mock.calls[0]?.[1]).toBe(failure);
		expect(service.getQueueSize()).toBe(0);
	} finally {
		await service.stop();
		await runtime.close();
	}
});
