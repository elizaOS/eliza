/**
 * Exercises the in-memory adapter's entity-deletion cascade for reference
 * rows that are entity-scoped in both the SQL schema and the in-memory
 * adapter: relationship edges (both endpoints) and attributed logs.
 */
import { describe, expect, it } from "vitest";
import type { Entity, UUID } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY_ID = "10000000-0000-0000-0000-000000000001" as UUID;
const OTHER_ENTITY_ID = "10000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "20000000-0000-0000-0000-000000000001" as UUID;

function entity(id: UUID, name: string): Entity {
	return {
		id,
		agentId: AGENT_ID,
		names: [name],
		metadata: {},
	};
}

describe("InMemoryDatabaseAdapter entity-delete cascade", () => {
	it("prunes relationship edges touching the deleted entity", async () => {
		const adapter = new InMemoryDatabaseAdapter(AGENT_ID);
		await adapter.createEntities([
			entity(ENTITY_ID, "Alice"),
			entity(OTHER_ENTITY_ID, "Bob"),
		]);
		await adapter.createRelationships([
			{
				sourceEntityId: ENTITY_ID,
				targetEntityId: OTHER_ENTITY_ID,
				tags: ["contact"],
			},
		]);

		await adapter.deleteEntities([ENTITY_ID]);

		await expect(
			adapter.getRelationships({ entityId: ENTITY_ID }),
		).resolves.toEqual([]);
		await expect(
			adapter.getRelationships({ entityId: OTHER_ENTITY_ID }),
		).resolves.toEqual([]);
		await expect(
			adapter.getRelationshipsByPairs([
				{ sourceEntityId: OTHER_ENTITY_ID, targetEntityId: ENTITY_ID },
			]),
		).resolves.toEqual([null]);
	});

	it("prunes log rows attributed to the deleted entity", async () => {
		const adapter = new InMemoryDatabaseAdapter(AGENT_ID);
		await adapter.createEntities([entity(ENTITY_ID, "Alice")]);
		await adapter.createLogs([
			{
				body: { text: "hello" },
				entityId: ENTITY_ID,
				roomId: ROOM_ID,
				type: "debug",
			},
		]);

		await adapter.deleteEntities([ENTITY_ID]);

		await expect(adapter.getLogs({ entityId: ENTITY_ID })).resolves.toEqual([]);
	});
});
