/**
 * Regression tests for the sort comparators inside RelationshipsService.
 * They drive the real service methods (`analyzeRelationship`,
 * `getRelationshipInsights`, `listOverdueFollowups`) against a hand-built fake
 * runtime, so a comparator that returns NaN, that loses the "never contacted"
 * (Infinity) extreme, or that leaves ties in arbitrary insertion order fails
 * here.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives";
import { RelationshipsService, safeSortNumber } from "./relationships";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const SOURCE = "22222222-2222-4222-8222-222222222222" as UUID;
const TARGET = "33333333-3333-4333-8333-333333333333" as UUID;
const ROOM = "44444444-4444-4444-8444-444444444444" as UUID;
const ENTITY_EARLY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const ENTITY_LATE = "ffffffff-ffff-4fff-8fff-ffffffffffff" as UUID;

describe("safeSortNumber", () => {
	it("collapses NaN to 0 and preserves infinities", () => {
		expect(safeSortNumber(Number.NaN)).toBe(0);
		expect(safeSortNumber("not-a-timestamp")).toBe(0);
		expect(safeSortNumber(undefined)).toBe(0);
		expect(safeSortNumber(Number.POSITIVE_INFINITY)).toBe(
			Number.POSITIVE_INFINITY,
		);
		expect(safeSortNumber(42)).toBe(42);
	});
});

describe("RelationshipsService.analyzeRelationship recency sort", () => {
	it("orders an unparseable createdAt before valid timestamps", async () => {
		const validAt = 1_700_000_000_000;
		const runtime = {
			agentId: AGENT_ID,
			async getRelationships() {
				return [
					{
						id: "rel-st",
						sourceEntityId: SOURCE,
						targetEntityId: TARGET,
						strength: 0,
					},
				];
			},
			async getRoomsForParticipant() {
				return [ROOM];
			},
			async getMemoriesByRoomIds({ offset }: { offset?: number }) {
				if (offset) return [];
				// Corrupted row last: a NaN-returning comparator leaves it in place
				// and `lastInteractionAt` then formats an invalid Date.
				return [
					{
						id: "m-valid",
						entityId: SOURCE,
						roomId: ROOM,
						createdAt: validAt,
						content: { text: "hello" },
					},
					{
						id: "m-corrupt",
						entityId: TARGET,
						roomId: ROOM,
						createdAt: "not-a-timestamp",
						content: { text: "hi" },
					},
				];
			},
			async createComponent() {
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);
		const analytics = await service.analyzeRelationship(SOURCE, TARGET);

		expect(analytics).not.toBeNull();
		expect(analytics?.lastInteractionAt).toBe(new Date(validAt).toISOString());
	});
});

describe("RelationshipsService.getRelationshipInsights ordering", () => {
	it("breaks equal-strength ties by entity id instead of insertion order", async () => {
		const recentAt = Date.now() - 60_000;
		const participants = [SOURCE, ENTITY_EARLY, ENTITY_LATE];
		// Identical timestamps and identical per-participant message counts make
		// both relationships score the same, so only the tie-break decides order.
		const messages = Array.from({ length: 30 }, (_, index) => ({
			id: `m-${index}`,
			entityId: participants[index % participants.length],
			roomId: ROOM,
			createdAt: recentAt,
			content: { text: "hey" },
		}));

		const runtime = {
			agentId: AGENT_ID,
			async getRelationships() {
				// Insertion order puts the higher id first; the comparator must reorder.
				return [
					{
						id: "rel-late",
						sourceEntityId: SOURCE,
						targetEntityId: ENTITY_LATE,
						strength: 0,
					},
					{
						id: "rel-early",
						sourceEntityId: SOURCE,
						targetEntityId: ENTITY_EARLY,
						strength: 0,
					},
				];
			},
			async getEntityById(id: UUID) {
				return { id, names: [String(id)], agentId: AGENT_ID };
			},
			async getRoomsForParticipant() {
				return [ROOM];
			},
			async getMemoriesByRoomIds({ offset }: { offset?: number }) {
				return offset ? [] : messages;
			},
			async createComponent() {
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);
		const insights = await service.getRelationshipInsights(SOURCE);

		expect(insights.strongestRelationships).toHaveLength(2);
		expect(
			insights.strongestRelationships.map((item) => item.entity.id),
		).toEqual([ENTITY_EARLY, ENTITY_LATE]);
		expect(insights.recentInteractions.map((item) => item.entity.id)).toEqual([
			ENTITY_EARLY,
			ENTITY_LATE,
		]);
	});
});

describe("RelationshipsService.listOverdueFollowups ordering", () => {
	it("keeps never-contacted contacts first and tie-breaks by entity id", async () => {
		const runtime = {
			agentId: AGENT_ID,
			async createComponent() {
				return true;
			},
			async updateComponent() {
				return true;
			},
			async getComponent() {
				return null;
			},
			async getComponents() {
				return [];
			},
			async getEntityById() {
				return null;
			},
		};

		const service = new RelationshipsService(runtime as never);
		const asOfMs = Date.parse("2026-01-01T00:00:00.000Z");
		const staleAt = new Date(asOfMs - 90 * 86_400_000).toISOString();

		// Registered stale-first, and the never-contacted contact last, so a
		// comparator that collapses Infinity to 0 sorts it to the end instead.
		await service.addContact(ENTITY_LATE);
		await service.updateContact(ENTITY_LATE, {
			followupThresholdDays: 7,
			lastInteractionAt: staleAt,
		});
		await service.addContact(ENTITY_EARLY);
		await service.updateContact(ENTITY_EARLY, {
			followupThresholdDays: 7,
			lastInteractionAt: staleAt,
		});
		await service.addContact(SOURCE);
		await service.updateContact(SOURCE, { followupThresholdDays: 7 });

		const overdue = await service.listOverdueFollowups({ asOfMs });

		expect(overdue.map((item) => item.contact.entityId)).toEqual([
			SOURCE,
			ENTITY_EARLY,
			ENTITY_LATE,
		]);
		expect(overdue[0].daysSinceInteraction).toBe(Number.POSITIVE_INFINITY);
	});
});
