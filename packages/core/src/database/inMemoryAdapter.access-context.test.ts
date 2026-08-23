/**
 * Exercises adapter-boundary access-context enforcement in the core fallback
 * store, including adversarial cross-world, cross-room, and pre-page filtering.
 */
import { describe, expect, it } from "vitest";
import type { AccessContext, Memory, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT = "00000000-0000-0000-0000-000000000001" as UUID;
const REQUESTER = "00000000-0000-0000-0000-000000000002" as UUID;
const STRANGER = "00000000-0000-0000-0000-000000000003" as UUID;
const ALLOWED_WORLD = "10000000-0000-0000-0000-000000000001" as UUID;
const OTHER_WORLD = "10000000-0000-0000-0000-000000000002" as UUID;
const ALLOWED_ROOM = "20000000-0000-0000-0000-000000000001" as UUID;
const OTHER_ROOM = "20000000-0000-0000-0000-000000000002" as UUID;
const OTHER_WORLD_ROOM = "20000000-0000-0000-0000-000000000003" as UUID;

const context: AccessContext = {
	requesterEntityId: REQUESTER,
	worldId: ALLOWED_WORLD,
	authorizedRoomIds: [ALLOWED_ROOM],
	role: "USER",
};

const vector = (first: number, second: number): number[] => [
	first,
	second,
	...Array.from({ length: 382 }, () => 0),
];

function memory(
	id: string,
	text: string,
	createdAt: number,
	overrides: Partial<Memory>,
): Memory {
	return {
		id: id as UUID,
		agentId: AGENT,
		entityId: REQUESTER,
		roomId: ALLOWED_ROOM,
		worldId: ALLOWED_WORLD,
		createdAt,
		content: { text },
		embedding: vector(0.8, 0.2),
		metadata: { type: "custom", scope: "global" },
		...overrides,
	};
}

async function seededAdapter(): Promise<InMemoryDatabaseAdapter> {
	const adapter = new InMemoryDatabaseAdapter(AGENT);
	await adapter.initialize();
	await adapter.createMemories(
		[
			memory(
				"30000000-0000-0000-0000-000000000001",
				"needle allowed global",
				100,
				{},
			),
			memory(
				"30000000-0000-0000-0000-000000000002",
				"needle allowed private",
				200,
				{
					embedding: vector(0.9, 0.1),
					metadata: { type: "custom", scope: "private" },
				},
			),
			memory(
				"30000000-0000-0000-0000-000000000003",
				"needle denied private",
				500,
				{
					entityId: STRANGER,
					embedding: vector(1, 0),
					metadata: { type: "custom", scope: "private" },
				},
			),
			memory(
				"30000000-0000-0000-0000-000000000004",
				"needle denied room",
				400,
				{ roomId: OTHER_ROOM, embedding: vector(1, 0) },
			),
			memory(
				"30000000-0000-0000-0000-000000000005",
				"needle denied world",
				300,
				{
					roomId: OTHER_WORLD_ROOM,
					worldId: OTHER_WORLD,
					embedding: vector(1, 0),
				},
			),
		].map((entry) => ({ memory: entry, tableName: "messages" })),
	);
	return adapter;
}

describe("InMemoryDatabaseAdapter access context", () => {
	it("filters scope, world, and room before list pagination", async () => {
		const adapter = await seededAdapter();
		const rows = await adapter.getMemories({
			tableName: "messages",
			accessContext: context,
			limit: 1,
		});

		expect(rows.map((row) => row.content.text)).toEqual([
			"needle allowed private",
		]);
	});

	it("intersects caller room ids with authorized rooms", async () => {
		const adapter = await seededAdapter();
		const rows = await adapter.getMemoriesByRoomIds({
			tableName: "messages",
			roomIds: [ALLOWED_ROOM, OTHER_ROOM, OTHER_WORLD_ROOM],
			accessContext: context,
		});

		expect(rows.map((row) => row.content.text)).toEqual([
			"needle allowed private",
			"needle allowed global",
		]);
	});

	it("filters before message ranking and vector top-k", async () => {
		const adapter = await seededAdapter();
		const textRows = await adapter.searchMessages({
			tableName: "messages",
			roomIds: [ALLOWED_ROOM, OTHER_ROOM, OTHER_WORLD_ROOM],
			query: "needle",
			accessContext: context,
			limit: 1,
		});
		const vectorRows = await adapter.searchMemories({
			tableName: "messages",
			embedding: vector(1, 0),
			match_threshold: 0,
			accessContext: context,
			limit: 1,
		});

		expect(textRows[0]?.memory.content.text).toMatch(/^needle allowed /);
		expect(vectorRows[0]?.content.text).toBe("needle allowed private");
	});

	it("denies every room-backed row for an explicit empty authorization", async () => {
		const adapter = await seededAdapter();
		await expect(
			adapter.getMemories({
				tableName: "messages",
				accessContext: { ...context, authorizedRoomIds: [] },
			}),
		).resolves.toEqual([]);
	});
});
