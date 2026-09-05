/**
 * Regression coverage for RelationshipsService analytics with corrupt/Infinity timestamps (issue #28599).
 * Verifies Defect 1 (NaN averageResponseTime) and Defect 2 (Infinity RangeError) are resolved.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives";
import { RelationshipsService } from "./relationships";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ROOM = "11111111-2222-4333-8444-555555555555" as UUID;

function makeRuntime(messages: unknown[]) {
	return {
		agentId: "11111111-1111-4111-8111-111111111111" as UUID,
		async getRelationships() {
			return [
				{
					id: "rel-ab",
					sourceEntityId: A,
					targetEntityId: B,
					strength: 0.5,
				},
			];
		},
		async getRoomsForParticipant() {
			return [ROOM];
		},
		async getMemoriesByRoomIds() {
			return messages as never[];
		},
		async createComponent() {
			return true;
		},
	};
}

describe("RelationshipsService analyzeRelationship corrupt timestamp guards", () => {
	it("does not return NaN averageResponseTime for corrupt string createdAt", async () => {
		const messages = [
			{
				id: "msg-1" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: 1000,
				content: { text: "Hello" },
			},
			{
				id: "msg-2" as UUID,
				entityId: B,
				roomId: ROOM,
				createdAt: "not-a-timestamp" as unknown as number,
				content: { text: "Corrupt timestamp" },
			},
		];
		const service = new RelationshipsService(makeRuntime(messages) as never);
		const analytics = await service.analyzeRelationship(A, B);
		expect(analytics).not.toBeNull();
		expect(
			analytics?.averageResponseTime === undefined ||
				Number.isFinite(analytics?.averageResponseTime as number),
		).toBe(true);
		expect(
			Number.isNaN(analytics?.averageResponseTime as unknown as number),
		).toBe(false);
	});

	it("does not throw RangeError for Infinity createdAt and returns finite or fallback lastInteractionAt", async () => {
		const messages = [
			{
				id: "msg-1" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: 1000,
				content: { text: "Hello" },
			},
			{
				id: "msg-inf" as UUID,
				entityId: B,
				roomId: ROOM,
				createdAt: Number.POSITIVE_INFINITY as unknown as number,
				content: { text: "Infinity timestamp" },
			},
		];
		const service = new RelationshipsService(makeRuntime(messages) as never);
		await expect(service.analyzeRelationship(A, B)).resolves.not.toThrow();
		const analytics = await service.analyzeRelationship(A, B);
		// With Infinity filtered, last interaction should be the finite one (1000) due to sort collapsing Infinity to 0
		// or fallback to relationship data; the key is no throw and not Infinity-derived ISO
		if (analytics?.lastInteractionAt) {
			expect(() =>
				new Date(analytics.lastInteractionAt as string).toISOString(),
			).not.toThrow();
		}
	});

	it("handles negative Infinity without throwing", async () => {
		const messages = [
			{
				id: "msg-neginf" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: Number.NEGATIVE_INFINITY as unknown as number,
				content: { text: "Neg Infinity" },
			},
			{
				id: "msg-1" as UUID,
				entityId: B,
				roomId: ROOM,
				createdAt: 2000,
				content: { text: "Hello" },
			},
		];
		const service = new RelationshipsService(makeRuntime(messages) as never);
		await expect(service.analyzeRelationship(A, B)).resolves.not.toThrow();
	});

	it("computes averageResponseTime correctly for valid finite timestamps", async () => {
		const messages = [
			{
				id: "msg-1" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: 1000,
				content: { text: "Hello" },
			},
			{
				id: "msg-2" as UUID,
				entityId: B,
				roomId: ROOM,
				createdAt: 3000,
				content: { text: "Hi" },
			},
		];
		const service = new RelationshipsService(makeRuntime(messages) as never);
		const analytics = await service.analyzeRelationship(A, B);
		expect(analytics?.averageResponseTime).toBe(2000);
	});

	it("returns undefined averageResponseTime when no valid cross-entity pair exists", async () => {
		const messages = [
			{
				id: "msg-1" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: "corrupt" as unknown as number,
				content: { text: "Bad" },
			},
			{
				id: "msg-2" as UUID,
				entityId: B,
				roomId: ROOM,
				createdAt: "also-bad" as unknown as number,
				content: { text: "Also bad" },
			},
		];
		const service = new RelationshipsService(makeRuntime(messages) as never);
		const analytics = await service.analyzeRelationship(A, B);
		expect(analytics?.averageResponseTime).toBeUndefined();
	});
});
