/**
 * Exercises safe NaN handling and tiebreaking in relationships graph builder
 * sorts including laterIso and recent conversations.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../types/index";
import {
	createNativeRelationshipsGraphService,
	laterIso,
} from "./relationships-graph-builder";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM_A = "aaaaaaaa-3333-4333-8333-333333333333" as UUID;
const ROOM_B = "bbbbbbbb-3333-4333-8333-333333333333" as UUID;
const ROOM_C = "cccccccc-3333-4333-8333-333333333333" as UUID;

describe("relationships-graph-builder safe sort", () => {
	it("laterIso handles valid dates, missing dates, and falls back to string tiebreak on NaN", () => {
		expect(laterIso("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")).toBe(
			"2026-02-01T00:00:00Z",
		);
		expect(laterIso(undefined, "2026-01-01T00:00:00Z")).toBe(
			"2026-01-01T00:00:00Z",
		);
		expect(laterIso("2026-01-01T00:00:00Z", undefined)).toBe(
			"2026-01-01T00:00:00Z",
		);

		const a = "not-a-date-a";
		const b = "not-a-date-b";
		const result = laterIso(a, b);
		expect(result).toBe(a.localeCompare(b) <= 0 ? a : b);
	});

	it("sorts recent conversations safely and tiebreaks equal timestamps by roomId without throwing", async () => {
		const roomMessages: Record<string, Memory[]> = {
			[ROOM_A]: [
				{
					id: "msg-a" as UUID,
					entityId: ENTITY_ID,
					roomId: ROOM_A,
					agentId: AGENT_ID,
					createdAt: 5000,
					content: { text: "tied recent A" },
				},
			],
			[ROOM_B]: [
				{
					id: "msg-b" as UUID,
					entityId: ENTITY_ID,
					roomId: ROOM_B,
					agentId: AGENT_ID,
					createdAt: 5000,
					content: { text: "tied recent B" },
				},
			],
			[ROOM_C]: [
				{
					id: "msg-c" as UUID,
					entityId: ENTITY_ID,
					roomId: ROOM_C,
					agentId: AGENT_ID,
					createdAt: Number.NaN,
					content: { text: "nan message" },
				},
			],
		};

		const runtime = {
			agentId: AGENT_ID,
			async getAllWorlds() {
				return [];
			},
			async getRoomsByWorlds() {
				return [];
			},
			async getRoomsForParticipants() {
				return [ROOM_A, ROOM_B, ROOM_C];
			},
			async getRoomsByIds(roomIds: UUID[]) {
				return roomIds.map((id) => ({ id, name: `Room ${id.slice(0, 8)}` }));
			},
			async getEntitiesForRoom() {
				return [];
			},
			async getRelationships() {
				return [];
			},
			async getEntityById(id: UUID) {
				if (id === ENTITY_ID) {
					return { id: ENTITY_ID, names: ["Alice"], metadata: {} };
				}
				return null;
			},
			async getMemories({
				tableName,
				roomId,
			}: {
				tableName: string;
				roomId?: UUID;
			}) {
				if (tableName === "messages" && roomId) {
					return roomMessages[roomId] ?? [];
				}
				return [];
			},
			getService() {
				return null;
			},
		} as unknown as IAgentRuntime;

		const service = createNativeRelationshipsGraphService(runtime, {
			async searchContacts() {
				return [
					{
						entityId: ENTITY_ID,
						name: "Alice",
						identifiers: [],
						contactPoint: "",
						confidence: 1,
					},
				];
			},
			async getCandidateMerges() {
				return [];
			},
		});

		const detail = await service.getPersonDetail(ENTITY_ID);
		expect(detail).not.toBeNull();
		expect(detail?.recentConversations).toHaveLength(3);

		// Equal timestamp conversations ROOM_A and ROOM_B are tiebroken by roomId (ROOM_A < ROOM_B)
		expect(detail?.recentConversations[0]?.roomId).toBe(ROOM_A);
		expect(detail?.recentConversations[1]?.roomId).toBe(ROOM_B);
		// NaN lastActivityAt is sorted last
		expect(detail?.recentConversations[2]?.roomId).toBe(ROOM_C);
	});
});
