/**
 * Tests `InMemoryDatabaseAdapter` relationship storage — create/update/delete
 * and query by pair, entity, tags, and ids, plus the defensive clone that
 * protects stored records from caller mutation. Runs against the real adapter.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types";
import { DEFAULT_UUID } from "../types/primitives";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const sourceEntityId = "10000000-0000-0000-0000-000000000001" as UUID;
const targetEntityId = "10000000-0000-0000-0000-000000000002" as UUID;
const alternateEntityId = "10000000-0000-0000-0000-000000000003" as UUID;

describe("InMemoryDatabaseAdapter relationships", () => {
	it("stores and queries relationships by pair, entity, tags, and ids", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();

		const ids = await adapter.createRelationships([
			{
				sourceEntityId,
				targetEntityId,
				tags: ["friend", "known"],
				metadata: { confidence: 0.8 },
			},
			{
				sourceEntityId: alternateEntityId,
				targetEntityId: sourceEntityId,
				tags: ["colleague"],
			},
		]);

		expect(ids).toHaveLength(2);

		const [direct, reverse, alternate] = await adapter.getRelationshipsByPairs([
			{ sourceEntityId, targetEntityId },
			{ sourceEntityId: targetEntityId, targetEntityId: sourceEntityId },
			{ sourceEntityId: alternateEntityId, targetEntityId: sourceEntityId },
		]);

		expect(direct).toMatchObject({
			id: ids[0],
			sourceEntityId,
			targetEntityId,
			agentId: DEFAULT_UUID,
			tags: ["friend", "known"],
			metadata: { confidence: 0.8 },
		});
		expect(direct?.createdAt).toEqual(expect.any(String));
		expect(reverse).toBeNull();
		expect(alternate?.id).toBe(ids[1]);

		const byEntity = await adapter.getRelationships({
			entityIds: [sourceEntityId],
		});
		expect(byEntity.map((relationship) => relationship.id)).toEqual(ids);

		const tagged = await adapter.getRelationships({
			entityIds: [sourceEntityId],
			tags: ["known"],
		});
		expect(tagged.map((relationship) => relationship.id)).toEqual([ids[0]]);

		const paged = await adapter.getRelationships({
			entityIds: [sourceEntityId],
			limit: 1,
			offset: 1,
		});
		expect(paged.map((relationship) => relationship.id)).toEqual([ids[1]]);

		const byIds = await adapter.getRelationshipsByIds([ids[1], ids[0]]);
		expect(byIds.map((relationship) => relationship.id)).toEqual([
			ids[1],
			ids[0],
		]);
	});

	it("updates, deletes, and protects stored relationships from caller mutation", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();

		const [relationshipId] = await adapter.createRelationships([
			{
				sourceEntityId,
				targetEntityId,
				tags: ["initial"],
				metadata: { note: "stored" },
			},
		]);

		const [returned] = await adapter.getRelationshipsByIds([relationshipId]);
		returned.tags.push("mutated");
		if (returned.metadata) {
			returned.metadata.note = "mutated";
		}

		const [stored] = await adapter.getRelationshipsByIds([relationshipId]);
		expect(stored.tags).toEqual(["initial"]);
		expect(stored.metadata).toEqual({ note: "stored" });

		await adapter.updateRelationships([
			{
				...stored,
				tags: ["updated"],
				metadata: { note: "updated" },
			},
		]);

		const [updated] = await adapter.getRelationshipsByIds([relationshipId]);
		expect(updated.tags).toEqual(["updated"]);
		expect(updated.metadata).toEqual({ note: "updated" });
		expect(updated.createdAt).toBe(stored.createdAt);

		await adapter.deleteRelationships([relationshipId]);

		expect(await adapter.getRelationshipsByIds([relationshipId])).toEqual([]);
		expect(
			await adapter.getRelationshipsByPairs([
				{ sourceEntityId, targetEntityId },
			]),
		).toEqual([null]);
	});
});
