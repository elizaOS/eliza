/**
 * Verifies the single-memory update wrapper immediately requeues embeddings
 * when a content-text update becomes embedding-less after persistence. SQL's
 * exact source_text join supplies that signal; unchanged text still returns a
 * vector and the existing queue guard remains a no-op.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, EventType, type Memory, type UUID } from "../../types";

const MEMORY_ID = "00000000-0000-0000-0000-000000000010" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000011" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-000000000012" as UUID;

function makeRuntime(): {
	runtime: AgentRuntime;
	adapter: InMemoryDatabaseAdapter;
} {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: {
			name: "EmbeddingContentUpdateAgent",
			bio: "test",
		} as Character,
		adapter,
		logLevel: "fatal",
	});
	return { runtime, adapter };
}

function persistedMemory(embedding?: number[]): Memory {
	return {
		id: MEMORY_ID,
		roomId: ROOM_ID,
		entityId: ENTITY_ID,
		content: { text: "updated source text" },
		...(embedding ? { embedding } : {}),
	};
}

describe("AgentRuntime content-update embedding requeue", () => {
	it("requeues when exact source binding makes the persisted memory embedding-less", async () => {
		const { runtime, adapter } = makeRuntime();
		const update = vi.spyOn(adapter, "updateMemories").mockResolvedValue();
		const get = vi
			.spyOn(adapter, "getMemoriesByIds")
			.mockResolvedValue([persistedMemory()]);
		const emit = vi.spyOn(runtime, "emitEvent").mockResolvedValue();

		await runtime.updateMemory({
			id: MEMORY_ID,
			content: { text: "updated source text" },
		});

		expect(update).toHaveBeenCalledWith([
			{ id: MEMORY_ID, content: { text: "updated source text" } },
		]);
		expect(get).toHaveBeenCalledWith([MEMORY_ID]);
		expect(emit).toHaveBeenCalledWith(
			EventType.EMBEDDING_GENERATION_REQUESTED,
			expect.objectContaining({
				memory: expect.objectContaining({ id: MEMORY_ID }),
				priority: "low",
			}),
		);
	});

	it("does not emit generation when exact source binding still returns a vector", async () => {
		const { runtime, adapter } = makeRuntime();
		vi.spyOn(adapter, "updateMemories").mockResolvedValue();
		vi.spyOn(adapter, "getMemoriesByIds").mockResolvedValue([
			persistedMemory([1, 0]),
		]);
		const emit = vi.spyOn(runtime, "emitEvent").mockResolvedValue();

		await runtime.updateMemory({
			id: MEMORY_ID,
			content: { text: "updated source text" },
		});

		expect(emit).not.toHaveBeenCalledWith(
			EventType.EMBEDDING_GENERATION_REQUESTED,
			expect.anything(),
		);
	});

	it("does not fetch or queue for metadata-only updates", async () => {
		const { runtime, adapter } = makeRuntime();
		vi.spyOn(adapter, "updateMemories").mockResolvedValue();
		const get = vi.spyOn(adapter, "getMemoriesByIds");
		const emit = vi.spyOn(runtime, "emitEvent").mockResolvedValue();

		await runtime.updateMemory({ id: MEMORY_ID, metadata: { source: "test" } });

		expect(get).not.toHaveBeenCalled();
		expect(emit).not.toHaveBeenCalledWith(
			EventType.EMBEDDING_GENERATION_REQUESTED,
			expect.anything(),
		);
	});
});
