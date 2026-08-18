import { describe, expect, it } from "vitest";
import {
	CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
	LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
} from "../constants/embeddings";
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
			LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
		);
		expect(first).toMatchObject({ changed: true, staleMemoryIds: [memoryId] });
		expect(
			(await adapter.getMemoriesByIds([memoryId]))[0]?.embedding,
		).toBeUndefined();

		await adapter.updateMemories([
			{ id: memoryId as UUID, embedding: new Array(384).fill(0.2) },
		]);
		const migrated = await adapter.reconcileEmbeddingSpace(
			CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
		);
		expect(migrated).toMatchObject({
			changed: true,
			previousFingerprint: LEGACY_BGE_SMALL_MEAN_EMBEDDING_SPACE_FINGERPRINT,
			staleMemoryIds: [memoryId],
		});
		expect(
			(await adapter.getMemoriesByIds([memoryId]))[0]?.embedding,
		).toBeUndefined();

		await adapter.updateMemories([
			{ id: memoryId as UUID, embedding: new Array(384).fill(0.3) },
		]);
		expect(
			await adapter.reconcileEmbeddingSpace(
				CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
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

	it("strips ineligible vectors without returning an endless reembed backlog", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init();
		const blankId = (
			await adapter.createMemories([
				{
					memory: {
						id: stringToUuid("blank-legacy-memory"),
						agentId: stringToUuid("agent"),
						entityId: stringToUuid("entity"),
						roomId: stringToUuid("room"),
						content: { text: "   " },
						embedding: new Array(384).fill(0.1),
					},
					tableName: "memories",
				},
			])
		)[0];

		expect(
			await adapter.reconcileEmbeddingSpace(
				CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
			),
		).toMatchObject({ changed: true, staleMemoryIds: [] });
		expect(
			(await adapter.getMemoriesByIds([blankId]))[0]?.embedding,
		).toBeUndefined();
		expect(
			await adapter.reconcileEmbeddingSpace(
				CANONICAL_EMBEDDING_SPACE_FINGERPRINT,
			),
		).toMatchObject({ changed: false, staleMemoryIds: [] });
	});
});
