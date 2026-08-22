/**
 * Pins analyzeRelationship to the source/target pair, not any row that
 * merely mentions the target entity.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives";
import { RelationshipsService } from "./relationships";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
const X = "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx" as UUID;

describe("RelationshipsService.analyzeRelationship pair predicate", () => {
	it("does not adopt a relationship that only shares the target entity", async () => {
		const writes: Array<Record<string, unknown>> = [];
		const runtime = {
			agentId: "11111111-1111-4111-8111-111111111111" as UUID,
			async getRelationships() {
				return [
					{
						id: "rel-bc",
						sourceEntityId: B,
						targetEntityId: C,
						strength: 0,
					},
					{
						id: "rel-xb",
						sourceEntityId: X,
						targetEntityId: B,
						strength: 0,
					},
					{
						id: "rel-ab",
						sourceEntityId: A,
						targetEntityId: B,
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
			async createComponent(component: { data?: Record<string, unknown> }) {
				writes.push(component.data ?? {});
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);
		const analytics = await service.analyzeRelationship(A, B);

		expect(analytics).not.toBeNull();
		expect(writes).toEqual([
			expect.objectContaining({
				targetEntityId: B,
			}),
		]);
		expect(writes[0]?.targetEntityId).not.toBe(C);
	});

	it("paginates every shared message and preserves every distinct topic", async () => {
		const roomId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;
		const topics = [
			"Alpha",
			"Bravo",
			"Charlie",
			"Delta",
			"Echo",
			"Foxtrot",
			"Golf",
			"Hotel",
			"India",
			"Juliet",
			"Kilo",
			"Lima",
			"Mike",
			"November",
			"Oscar",
		];
		const messages = Array.from({ length: 205 }, (_, index) => ({
			id: `memory-${index}` as UUID,
			entityId: index % 2 === 0 ? A : B,
			roomId,
			createdAt: index,
			content: { text: topics[index % topics.length] },
		}));
		const offsets: number[] = [];
		const runtime = {
			agentId: "11111111-1111-4111-8111-111111111111" as UUID,
			async getRelationships() {
				return [];
			},
			async getRoomsForParticipant() {
				return [roomId];
			},
			async getMemoriesByRoomIds(params: { limit?: number; offset?: number }) {
				const offset = params.offset ?? 0;
				offsets.push(offset);
				return messages.slice(offset, offset + (params.limit ?? 20));
			},
			async createComponent() {
				return true;
			},
		};

		const service = new RelationshipsService(runtime as never);
		const analytics = await service.analyzeRelationship(A, B);

		expect(offsets).toEqual([0, 200]);
		expect(analytics?.topicsDiscussed).toEqual(topics);
	});

	it("fails explicitly when a memory adapter ignores the page offset", async () => {
		const roomId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;
		const repeatedPage = Array.from({ length: 200 }, (_, index) => ({
			id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID,
			entityId: index % 2 === 0 ? A : B,
			roomId,
			content: { text: `topic-${index}` },
		}));
		const runtime = {
			agentId: "11111111-1111-4111-8111-111111111111" as UUID,
			async getRelationships() {
				return [];
			},
			async getRoomsForParticipant() {
				return [roomId];
			},
			async getMemoriesByRoomIds() {
				return repeatedPage;
			},
		};

		const service = new RelationshipsService(runtime as never);
		await expect(service.analyzeRelationship(A, B)).rejects.toMatchObject({
			code: "RELATIONSHIP_MESSAGE_PAGINATION_STALLED",
			context: { offset: 200, pageSize: 200 },
		});
	});
});
