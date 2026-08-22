/**
 * Drives the real {@link InMemoryDatabaseAdapter} searchMemories / embedding-
 * reclaim path with no stand-in for the adapter. Pins the plugin-sql contract:
 * scope eligibility is applied before the top-K cut, mixed-width vectors are
 * skipped rather than scored, and clearEmbeddingsOutsideActiveDimension
 * actually strips stale-width embeddings so a later search cannot rank them.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter.ts";

const DIM = 4;

function onAxis(dimension = DIM): number[] {
	const embedding = Array.from({ length: dimension }, () => 0);
	embedding[0] = 1;
	return embedding;
}

function offAxis(tilt: number, dimension = DIM): number[] {
	const embedding = Array.from({ length: dimension }, () => 0);
	embedding[0] = 1;
	embedding[1] = tilt;
	const norm = Math.hypot(1, tilt);
	return embedding.map((value) => value / norm);
}

describe("InMemoryDatabaseAdapter.searchMemories", () => {
	const agentId = randomUUID() as UUID;
	const roomA = randomUUID() as UUID;
	const roomB = randomUUID() as UUID;
	const worldA = randomUUID() as UUID;
	const worldB = randomUUID() as UUID;
	const entityA = randomUUID() as UUID;
	const entityB = randomUUID() as UUID;

	async function seed(
		memories: Memory[],
		tableName = "memories",
	): Promise<InMemoryDatabaseAdapter> {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		await adapter.createMemories(
			memories.map((memory) => ({ memory, tableName })),
		);
		return adapter;
	}

	it("returns the in-room top-K even when a larger off-room corpus holds closer vectors", async () => {
		const crowd: Memory[] = Array.from({ length: 20 }, (_, i) => ({
			entityId: entityB,
			roomId: roomB,
			agentId,
			content: { text: `crowd ${i}` },
			embedding: onAxis(),
		}));
		const inRoom: Memory[] = Array.from({ length: 5 }, (_, i) => ({
			entityId: entityA,
			roomId: roomA,
			agentId,
			content: { text: `roomA ${i}` },
			embedding: offAxis(0.05 + i * 0.01),
		}));
		const adapter = await seed([...crowd, ...inRoom]);

		const results = await adapter.searchMemories({
			tableName: "memories",
			embedding: onAxis(),
			match_threshold: 0,
			count: 3,
			roomId: roomA,
		});

		expect(results).toHaveLength(3);
		for (const memory of results) {
			expect(memory.roomId).toBe(roomA);
		}
		expect(results[0]?.content.text).toBe("roomA 0");
		const similarities = results.map((memory) => memory.similarity ?? 0);
		expect(similarities[0]).toBeGreaterThanOrEqual(similarities[1] ?? 0);
		expect(similarities[1]).toBeGreaterThanOrEqual(similarities[2] ?? 0);
	});

	it("honors worldId scope past a crowd of closer out-of-world vectors", async () => {
		const crowd: Memory[] = Array.from({ length: 15 }, (_, i) => ({
			entityId: entityB,
			roomId: roomB,
			worldId: worldB,
			agentId,
			content: { text: `world crowd ${i}` },
			embedding: onAxis(),
		}));
		const inWorld: Memory[] = Array.from({ length: 4 }, (_, i) => ({
			entityId: entityA,
			roomId: roomA,
			worldId: worldA,
			agentId,
			content: { text: `worldA ${i}` },
			embedding: offAxis(0.05 + i * 0.01),
		}));
		const adapter = await seed([...crowd, ...inWorld]);

		const results = await adapter.searchMemories({
			tableName: "memories",
			embedding: onAxis(),
			match_threshold: 0,
			count: 4,
			worldId: worldA,
		});

		expect(results).toHaveLength(4);
		for (const memory of results) {
			expect(memory.worldId).toBe(worldA);
		}
	});

	it("skips mixed-width vectors instead of ranking them against the query", async () => {
		const adapter = await seed([
			{
				entityId: entityA,
				roomId: roomA,
				agentId,
				content: { text: "active width" },
				embedding: onAxis(4),
			},
			{
				entityId: entityA,
				roomId: roomA,
				agentId,
				content: { text: "stale width" },
				embedding: onAxis(1536),
			},
		]);

		const results = await adapter.searchMemories({
			tableName: "memories",
			embedding: onAxis(4),
			match_threshold: 0,
			count: 10,
		});

		expect(results.map((memory) => memory.content.text)).toEqual([
			"active width",
		]);
	});

	it("returns an empty list when no memory has an embedding", async () => {
		const adapter = await seed([
			{
				entityId: entityA,
				roomId: roomA,
				agentId,
				content: { text: "no vector" },
			},
		]);
		const results = await adapter.searchMemories({
			tableName: "memories",
			embedding: onAxis(),
			count: 10,
		});
		expect(results).toEqual([]);
	});

	it("applies no similarity floor when match_threshold is absent or zero, and filters when set", async () => {
		const adapter = await seed([
			{
				entityId: entityA,
				roomId: roomA,
				agentId,
				content: { text: "near" },
				embedding: offAxis(0.1),
			},
			{
				entityId: entityA,
				roomId: roomA,
				agentId,
				content: { text: "far" },
				embedding: offAxis(2),
			},
			{
				entityId: entityA,
				roomId: roomA,
				agentId,
				content: { text: "opposite" },
				embedding: onAxis().map((value) => -value),
			},
		]);

		const texts = (memories: Memory[]) =>
			memories.map((memory) => memory.content.text);

		expect(
			texts(
				await adapter.searchMemories({
					tableName: "memories",
					embedding: onAxis(),
				}),
			),
		).toEqual(["near", "far", "opposite"]);
		expect(
			texts(
				await adapter.searchMemories({
					tableName: "memories",
					embedding: onAxis(),
					match_threshold: 0,
				}),
			),
		).toEqual(["near", "far", "opposite"]);
		expect(
			texts(
				await adapter.searchMemories({
					tableName: "memories",
					embedding: onAxis(),
					match_threshold: 0.5,
				}),
			),
		).toEqual(["near"]);
	});

	it("treats entityId as a row predicate like the SQL vector search", async () => {
		const adapter = await seed([
			{
				entityId: entityA,
				roomId: roomA,
				agentId,
				content: { text: "mine" },
				embedding: offAxis(0.2),
			},
			{
				entityId: entityB,
				roomId: roomA,
				agentId,
				content: { text: "theirs" },
				embedding: onAxis(),
			},
		]);

		const results = await adapter.searchMemories({
			tableName: "memories",
			embedding: onAxis(),
			entityId: entityA,
			count: 5,
		});
		expect(results.map((memory) => memory.content.text)).toEqual(["mine"]);
	});
});

describe("InMemoryDatabaseAdapter.clearEmbeddingsOutsideActiveDimension", () => {
	it("strips old-width vectors so they cannot occupy later search results", async () => {
		const agentId = randomUUID() as UUID;
		const entityId = randomUUID() as UUID;
		const roomId = randomUUID() as UUID;
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		await adapter.ensureEmbeddingDimension(1536);
		const stale: Memory = {
			id: randomUUID() as UUID,
			agentId,
			entityId,
			roomId,
			content: { text: "old cloud embedding" },
			embedding: onAxis(1536),
		};
		const [staleId] = await adapter.createMemories([
			{ memory: stale, tableName: "memories" },
		]);

		await adapter.ensureEmbeddingDimension(4);
		expect(await adapter.clearEmbeddingsOutsideActiveDimension()).toEqual([
			staleId,
		]);

		const reclaimed = await adapter.getMemoriesByIds([staleId]);
		expect(reclaimed[0]?.embedding).toBeUndefined();

		const fresh: Memory = {
			id: randomUUID() as UUID,
			agentId,
			entityId,
			roomId,
			content: { text: "active local embedding" },
			embedding: onAxis(4),
		};
		const [freshId] = await adapter.createMemories([
			{ memory: fresh, tableName: "memories" },
		]);

		const results = await adapter.searchMemories({
			tableName: "memories",
			embedding: onAxis(4),
			match_threshold: 0,
			limit: 10,
		});
		expect(results.map((memory) => memory.id)).toEqual([freshId]);
		expect(await adapter.clearEmbeddingsOutsideActiveDimension()).toEqual([]);
	});
});
