/**
 * Exercises RelationshipsService.analyzeRelationship interaction history sorting
 * with non-finite/NaN and equal timestamps.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives";
import { RelationshipsService } from "./relationships";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const ROOM = "11111111-2222-4333-8444-555555555555" as UUID;

describe("RelationshipsService.analyzeRelationship interaction history sort", () => {
	it("sorts interactions with NaN and undefined timestamps safely to index 0", async () => {
		const messages = [
			{
				id: "msg-2000" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: 2000,
				content: { text: "two thousand" },
			},
			{
				id: "msg-nan-b" as UUID,
				entityId: B,
				roomId: ROOM,
				createdAt: Number.NaN,
				content: { text: "nan b" },
			},
			{
				id: "msg-1000" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: 1000,
				content: { text: "one thousand" },
			},
			{
				id: "msg-nan-a" as UUID,
				entityId: B,
				roomId: ROOM,
				createdAt: Number.NaN,
				content: { text: "nan a" },
			},
			{
				id: "msg-undef" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: undefined as unknown as number,
				content: { text: "undefined timestamp" },
			},
		];

		const runtime = {
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
				return messages;
			},
			async createComponent() {
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);
		const analytics = await service.analyzeRelationship(A, B);

		expect(analytics).not.toBeNull();
		// lastInteractionAt is derived from interactions[interactions.length - 1].createdAt converted to ISO string
		expect(analytics?.lastInteractionAt).toBe(new Date(2000).toISOString());
		expect(analytics?.interactionCount).toBe(5);
	});

	it("tiebreaks equal timestamps deterministically by message id", async () => {
		const messages = [
			{
				id: "msg-z" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: 500,
				content: { text: "Zulu topic" },
			},
			{
				id: "msg-a" as UUID,
				entityId: B,
				roomId: ROOM,
				createdAt: 500,
				content: { text: "Alpha topic" },
			},
			{
				id: "msg-m" as UUID,
				entityId: A,
				roomId: ROOM,
				createdAt: 500,
				content: { text: "Mike topic" },
			},
		];

		const runtime = {
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
				return messages;
			},
			async createComponent() {
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);
		const analytics = await service.analyzeRelationship(A, B);

		expect(analytics).not.toBeNull();
		expect(analytics?.interactionCount).toBe(3);
		expect(analytics?.lastInteractionAt).toBe(new Date(500).toISOString());
		// topicsDiscussed preserves the sorted interaction order, so it is the
		// observable proof that equal timestamps are broken by message id
		// ("msg-a" < "msg-m" < "msg-z") rather than left in insertion order.
		expect(analytics?.topicsDiscussed).toEqual(["Alpha", "Mike", "Zulu"]);
	});
});
