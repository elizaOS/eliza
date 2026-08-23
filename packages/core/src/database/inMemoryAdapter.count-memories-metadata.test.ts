/**
 * Deterministic in-memory adapter coverage: countMemories must honor the same
 * `metadata` matcher getMemories applies, so a metadata-filtered count equals
 * getMemories({ metadata }).length for both the room-scoped and unscoped paths.
 */
import { describe, expect, it } from "vitest";
import type { Memory, MemoryMetadata, UUID } from "../types";
import { stringToUuid } from "../utils.ts";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter.ts";

const TABLE = "messages";
const ROOM = stringToUuid("room-count-metadata") as UUID;

async function seed(): Promise<InMemoryDatabaseAdapter> {
	const adapter = new InMemoryDatabaseAdapter();
	await adapter.init?.();
	const make = (
		i: number,
		source: string,
	): { memory: Memory; tableName: string } => ({
		memory: {
			entityId: stringToUuid(`e-${i}`) as UUID,
			roomId: ROOM,
			content: { text: `m${i}` },
			metadata: { source } as MemoryMetadata,
		},
		tableName: TABLE,
	});
	await adapter.createMemories([
		make(1, "alpha"),
		make(2, "alpha"),
		make(3, "alpha"),
		make(4, "beta"),
		make(5, "beta"),
	]);
	return adapter;
}

describe("InMemoryDatabaseAdapter.countMemories metadata filter", () => {
	it("counts only memories matching the metadata filter (no room filter)", async () => {
		const adapter = await seed();
		const filter = { source: "alpha" };
		const count = await adapter.countMemories({
			tableName: TABLE,
			metadata: filter,
		});
		const got = await adapter.getMemories({
			tableName: TABLE,
			metadata: filter,
		});
		expect(count).toBe(3);
		expect(count).toBe(got.length);
	});

	it("counts only matching memories within a room filter", async () => {
		const adapter = await seed();
		const filter = { source: "beta" };
		const count = await adapter.countMemories({
			roomIds: [ROOM],
			tableName: TABLE,
			metadata: filter,
		});
		const got = await adapter.getMemories({
			roomId: ROOM,
			tableName: TABLE,
			metadata: filter,
		});
		expect(count).toBe(2);
		expect(count).toBe(got.length);
	});

	it("counts every memory when no metadata filter is given", async () => {
		const adapter = await seed();
		expect(await adapter.countMemories({ tableName: TABLE })).toBe(5);
	});

	it("counts zero when the metadata filter matches nothing", async () => {
		const adapter = await seed();
		const filter = { source: "gamma" };
		const count = await adapter.countMemories({
			tableName: TABLE,
			metadata: filter,
		});
		const got = await adapter.getMemories({
			tableName: TABLE,
			metadata: filter,
		});
		expect(count).toBe(0);
		expect(count).toBe(got.length);
	});
});

describe("InMemoryDatabaseAdapter.getMemoriesByRoomIds completeness", () => {
	it("returns the complete room set when no explicit page limit is supplied", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.init?.();
		await adapter.createMemories(
			Array.from({ length: 25 }, (_, index) => ({
				memory: {
					entityId: stringToUuid(`room-history-entity-${index}`) as UUID,
					roomId: ROOM,
					createdAt: index,
					content: { text: `history-${index}` },
				} satisfies Memory,
				tableName: TABLE,
			})),
		);

		const memories = await adapter.getMemoriesByRoomIds({
			tableName: TABLE,
			roomIds: [ROOM],
		});

		expect(memories).toHaveLength(25);
		expect(memories.map((memory) => memory.content.text)).toContain(
			"history-0",
		);
	});
});
