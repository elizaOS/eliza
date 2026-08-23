/**
 * Regression coverage for the deterministic ordering of RelationshipsService
 * result lists. Every case drives the real service methods
 * (`getRelationshipInsights`, `listOverdueFollowups`) against a stubbed runtime
 * and the service's own contact cache; no comparator is reimplemented here, so
 * reverting a comparator makes these fail. The harness is deterministic and
 * offline — no database, no model calls.
 */
import { describe, expect, it, vi } from "vitest";
import type { Entity } from "../types/primitives";
import type { UUID } from "../types/primitives";
import {
	type ContactInfo,
	type RelationshipAnalytics,
	RelationshipsService,
} from "./relationships";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const SELF = "00000000-0000-4000-8000-000000000000" as UUID;
const ENTITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ENTITY_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

function entity(id: UUID): Entity {
	return { id, names: [id], agentId: AGENT_ID } as Entity;
}

function analytics(
	strength: number,
	lastInteractionAt: string,
): RelationshipAnalytics {
	return {
		strength,
		interactionCount: 1,
		lastInteractionAt,
		topicsDiscussed: [],
	};
}

function contact(entityId: UUID, lastInteractionAt?: string): ContactInfo {
	return {
		entityId,
		categories: [],
		tags: [],
		preferences: {} as ContactInfo["preferences"],
		customFields: {},
		privacyLevel: "private",
		lastModified: new Date(0).toISOString(),
		handles: [],
		interactions: [],
		followupThresholdDays: 30,
		lastInteractionAt,
		relationshipStatus: "active",
	};
}

describe("RelationshipsService.getRelationshipInsights ordering", () => {
	it("breaks an equal-strength tie by entity id instead of by query order", async () => {
		// The runtime hands back the higher id first; with a bare
		// `b.strength - a.strength` the tie is decided by that arrival order,
		// which is not stable across queries.
		const lastInteractionAt = new Date(Date.now() - 60 * 86_400_000).toISOString();
		const runtime = {
			agentId: AGENT_ID,
			async getRelationships() {
				return [
					{ id: "rel-c", sourceEntityId: SELF, targetEntityId: ENTITY_C },
					{ id: "rel-b", sourceEntityId: SELF, targetEntityId: ENTITY_B },
				];
			},
			async getEntityById(id: UUID) {
				return entity(id);
			},
		};
		const service = new RelationshipsService(runtime as never);
		vi.spyOn(service, "analyzeRelationship").mockImplementation(
			async () => analytics(90, lastInteractionAt),
		);

		const insights = await service.getRelationshipInsights(SELF);

		expect(insights.strongestRelationships.map((row) => row.entity.id)).toEqual([
			ENTITY_B,
			ENTITY_C,
		]);
		// Same tie, same rule, on the attention list built from the same rows.
		expect(insights.needsAttention.map((row) => row.entity.id)).toEqual([
			ENTITY_B,
			ENTITY_C,
		]);
	});

	it("breaks an equal-recency tie on recentInteractions by entity id", async () => {
		const lastInteractionAt = new Date(Date.now() - 86_400_000).toISOString();
		const runtime = {
			agentId: AGENT_ID,
			async getRelationships() {
				return [
					{ id: "rel-c", sourceEntityId: SELF, targetEntityId: ENTITY_C },
					{ id: "rel-b", sourceEntityId: SELF, targetEntityId: ENTITY_B },
				];
			},
			async getEntityById(id: UUID) {
				return entity(id);
			},
		};
		const service = new RelationshipsService(runtime as never);
		vi.spyOn(service, "analyzeRelationship").mockImplementation(
			async () => analytics(10, lastInteractionAt),
		);

		const insights = await service.getRelationshipInsights(SELF);

		expect(insights.recentInteractions.map((row) => row.entity.id)).toEqual([
			ENTITY_B,
			ENTITY_C,
		]);
	});
});

describe("RelationshipsService.listOverdueFollowups ordering", () => {
	function serviceWithContacts(contacts: ContactInfo[]): RelationshipsService {
		const service = new RelationshipsService({ agentId: AGENT_ID } as never);
		const cache = (
			service as unknown as { contactInfoCache: Map<UUID, ContactInfo> }
		).contactInfoCache;
		for (const item of contacts) {
			cache.set(item.entityId, item);
		}
		return service;
	}

	it("keeps never-contacted entries at the top of the overdue list", async () => {
		// A missing lastInteractionAt is recorded as +Infinity days overdue —
		// the most urgent state there is. Folding it to 0 would bury it.
		const asOfMs = Date.parse("2026-08-23T00:00:00.000Z");
		const service = serviceWithContacts([
			contact(ENTITY_B, new Date(asOfMs - 100 * 86_400_000).toISOString()),
			contact(ENTITY_C),
		]);

		const overdue = await service.listOverdueFollowups({ asOfMs });

		expect(overdue.map((row) => row.contact.entityId)).toEqual([
			ENTITY_C,
			ENTITY_B,
		]);
		expect(overdue[0].daysSinceInteraction).toBe(Number.POSITIVE_INFINITY);
	});

	it("breaks a never-contacted tie by contact id", async () => {
		const asOfMs = Date.parse("2026-08-23T00:00:00.000Z");
		const service = serviceWithContacts([contact(ENTITY_C), contact(ENTITY_B)]);

		const overdue = await service.listOverdueFollowups({ asOfMs });

		expect(overdue.map((row) => row.contact.entityId)).toEqual([
			ENTITY_B,
			ENTITY_C,
		]);
	});
});
