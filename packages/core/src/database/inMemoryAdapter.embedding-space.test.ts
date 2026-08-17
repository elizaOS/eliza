import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types";
import { stringToUuid } from "../utils";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

describe("InMemoryDatabaseAdapter embedding-space reconciliation", () => {
	it("clears untagged same-width vectors and preserves vectors after fingerprint pinning", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const memory: Memory = {
			id: stringToUuid("legacy-memory"),
			agentId: stringToUuid("agent"),
			entityId: stringToUuid("entity"),
			roomId: stringToUuid("room"),
			content: { text: "legacy GTE vector" },
			embedding: new Array(384).fill(0.1),
		};
		const [memoryId] = await adapter.createMemories([
			{ memory, tableName: "memories" },
		]);

		const first = await adapter.reconcileEmbeddingSpace(
			"BAAI/bge-small-en-v1.5:384:mean:l2:v1",
		);
		expect(first).toMatchObject({ changed: true, staleMemoryIds: [memoryId] });
		expect(
			(await adapter.getMemoriesByIds([memoryId]))[0]?.embedding,
		).toBeUndefined();

		await adapter.updateMemories([
			{ id: memoryId as UUID, embedding: new Array(384).fill(0.2) },
		]);
		expect(
			await adapter.reconcileEmbeddingSpace(
				"BAAI/bge-small-en-v1.5:384:mean:l2:v1",
			),
		).toMatchObject({ changed: false, staleMemoryIds: [] });
		expect(
			(await adapter.getMemoriesByIds([memoryId]))[0]?.embedding,
		).toHaveLength(384);

		await adapter.updateMemories([
			{ id: memoryId as UUID, content: { text: "updated BGE source text" } },
		]);
		expect(
			(await adapter.getMemoriesByIds([memoryId]))[0]?.embedding,
		).toBeUndefined();
	});
});
