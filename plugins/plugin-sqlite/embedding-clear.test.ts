/** Clearing a stored embedding must also drop its HNSW entry: otherwise vector
 * search keeps returning the memory ranked by a vector it no longer has. */

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory, UUID } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteDatabaseAdapter } from "./adapter";

const id = () => randomUUID() as UUID;
const agentId = id();
const roomId = id();
const entityId = id();
let directory: string;
const opened: SQLiteDatabaseAdapter[] = [];

async function open() {
	const adapter = SQLiteDatabaseAdapter.create(
		join(directory, "agent.sqlite"),
		agentId,
	);
	opened.push(adapter);
	await adapter.initialize();
	await adapter.ensureEmbeddingDimension(3);
	return adapter;
}

function memory(text: string): Memory & { id: UUID } {
	return {
		id: id(),
		agentId,
		entityId,
		roomId,
		content: { text },
		createdAt: Date.now(),
		embedding: [1, 0, 0],
	};
}

async function search(adapter: SQLiteDatabaseAdapter) {
	return adapter.searchMemories({
		tableName: "messages",
		embedding: [1, 0, 0],
		roomId,
		count: 10,
		match_threshold: 0.5,
	});
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "eliza-sqlite-"));
});

afterEach(async () => {
	for (const adapter of opened.splice(0)) await adapter.close();
	await rm(directory, { recursive: true, force: true });
});

describe("clearing a memory embedding drops its vector index entry", () => {
	it("updateMemories with an empty embedding stops returning the memory from search", async () => {
		const adapter = await open();
		const mem = memory("clear me");
		await adapter.createMemories([{ memory: mem, tableName: "messages" }]);
		expect((await search(adapter)).map((row) => row.id)).toEqual([mem.id]);

		await adapter.updateMemories([{ id: mem.id, embedding: [] }]);

		const stored = await adapter.getMemoriesByIds([mem.id]);
		expect(stored[0]?.embedding ?? []).toEqual([]);
		expect(await search(adapter)).toEqual([]);
	});

	it("upsertMemories with an empty embedding stops returning the memory from search", async () => {
		const adapter = await open();
		const mem = memory("clear me too");
		await adapter.createMemories([{ memory: mem, tableName: "messages" }]);
		expect((await search(adapter)).map((row) => row.id)).toEqual([mem.id]);

		await adapter.upsertMemories([
			{ memory: { ...mem, embedding: [] }, tableName: "messages" },
		]);

		const stored = await adapter.getMemoriesByIds([mem.id]);
		expect(stored[0]?.embedding ?? []).toEqual([]);
		expect(await search(adapter)).toEqual([]);
	});

	it("updateMemories without an embedding keeps the memory searchable", async () => {
		const adapter = await open();
		const mem = memory("keep me");
		await adapter.createMemories([{ memory: mem, tableName: "messages" }]);

		await adapter.updateMemories([
			{ id: mem.id, content: { text: "keep me, edited" } },
		]);

		const stored = await adapter.getMemoriesByIds([mem.id]);
		expect(stored[0]?.embedding).toEqual([1, 0, 0]);
		expect((await search(adapter)).map((row) => row.id)).toEqual([mem.id]);
	});
});
