/**
 * Unit tests for RelationshipsService.analyzeRelationship caching semantics.
 * Verifies that unordered entity pairs share a canonical cache entry regardless
 * of argument order, and that TTL expiry is evaluated against computation time.
 */
import { describe, expect, it, vi } from "vitest";
import type { UUID } from "../types/primitives";
import { RelationshipsService } from "./relationships";

const ENTITY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const ENTITY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;

describe("RelationshipsService.analyzeRelationship cache", () => {
	it("shares canonical cache between reversed entity arguments", async () => {
		let queryCount = 0;
		let writeCount = 0;

		const runtime = {
			agentId: "11111111-1111-4111-8111-111111111111" as UUID,
			async getRelationships() {
				queryCount += 1;
				return [
					{
						id: "rel-ab",
						sourceEntityId: ENTITY_A,
						targetEntityId: ENTITY_B,
						strength: 0,
						lastInteractionAt: new Date(Date.now() - 86400000).toISOString(),
					},
				];
			},
			async getRoomsForParticipant() {
				return [];
			},
			async getMemoriesByRoomIds() {
				return [];
			},
			async createComponent() {
				writeCount += 1;
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);

		// First call: computes and caches
		const first = await service.analyzeRelationship(ENTITY_A, ENTITY_B);
		expect(first).not.toBeNull();
		expect(queryCount).toBe(1);
		expect(writeCount).toBe(1);

		// Second call with reversed argument order: must hit canonical cache
		const second = await service.analyzeRelationship(ENTITY_B, ENTITY_A);
		expect(second).not.toBeNull();
		expect(second).toEqual(first);
		expect(queryCount).toBe(1);
		expect(writeCount).toBe(1);
	});

	it("serves cached analytics when lastInteractionAt is older than 1 hour", async () => {
		let queryCount = 0;

		const oldInteractionTime = new Date(
			Date.now() - 7 * 86400000,
		).toISOString();
		const runtime = {
			agentId: "11111111-1111-4111-8111-111111111111" as UUID,
			async getRelationships() {
				queryCount += 1;
				return [
					{
						id: "rel-ab",
						sourceEntityId: ENTITY_A,
						targetEntityId: ENTITY_B,
						strength: 0,
						lastInteractionAt: oldInteractionTime,
					},
				];
			},
			async getRoomsForParticipant() {
				return [];
			},
			async getMemoriesByRoomIds() {
				return [];
			},
			async createComponent() {
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);

		// Compute fresh analytics for relationship with old interaction
		const first = await service.analyzeRelationship(ENTITY_A, ENTITY_B);
		expect(first).not.toBeNull();
		expect(queryCount).toBe(1);

		// Subsequent call within 1 hour must hit cache even though lastInteractionAt is 7 days ago
		const second = await service.analyzeRelationship(ENTITY_A, ENTITY_B);
		expect(second).not.toBeNull();
		expect(queryCount).toBe(1);
	});

	it("recomputes when the cache entry has exceeded 1 hour TTL", async () => {
		let queryCount = 0;

		const runtime = {
			agentId: "11111111-1111-4111-8111-111111111111" as UUID,
			async getRelationships() {
				queryCount += 1;
				return [
					{
						id: "rel-ab",
						sourceEntityId: ENTITY_A,
						targetEntityId: ENTITY_B,
						strength: 0,
					},
				];
			},
			async getRoomsForParticipant() {
				return [];
			},
			async getMemoriesByRoomIds() {
				return [];
			},
			async createComponent() {
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);

		const now = Date.now();
		vi.spyOn(Date, "now").mockReturnValue(now);

		await service.analyzeRelationship(ENTITY_A, ENTITY_B);
		expect(queryCount).toBe(1);

		// Advance time by 30 minutes: still in cache
		vi.spyOn(Date, "now").mockReturnValue(now + 30 * 60 * 1000);
		await service.analyzeRelationship(ENTITY_A, ENTITY_B);
		expect(queryCount).toBe(1);

		// Advance time past 1 hour: expired, recomputes
		vi.spyOn(Date, "now").mockReturnValue(now + 61 * 60 * 1000);
		await service.analyzeRelationship(ENTITY_A, ENTITY_B);
		expect(queryCount).toBe(2);

		vi.restoreAllMocks();
	});
});
