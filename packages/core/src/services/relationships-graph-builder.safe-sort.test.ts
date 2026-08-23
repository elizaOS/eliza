/**
 * Exercises the deterministic recency ordering of the relationships graph
 * builder: laterIso, and the person-detail sorts for recent conversations,
 * facts, and relevant memories. Every assertion drives the exported production
 * code through a stubbed runtime; no comparator is reimplemented here.
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
const FACT_EARLY_ID = "aaaaaaaa-4444-4444-8444-444444444444";
const FACT_LATE_ID = "ffffffff-4444-4444-8444-444444444444";
const MEMORY_EARLY_ID = "aaaaaaaa-5555-4555-8555-555555555555";
const MEMORY_LATE_ID = "ffffffff-5555-4555-8555-555555555555";

const TIED_AT = Date.UTC(2026, 0, 2, 3, 4, 5);

describe("relationships-graph-builder safe sort", () => {
	it("laterIso handles valid dates, missing dates, and falls back to a string tiebreak on unparseable input", () => {
		expect(laterIso("2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z")).toBe(
			"2026-02-01T00:00:00Z",
		);
		expect(laterIso(undefined, "2026-01-01T00:00:00Z")).toBe(
			"2026-01-01T00:00:00Z",
		);
		expect(laterIso("2026-01-01T00:00:00Z", undefined)).toBe(
			"2026-01-01T00:00:00Z",
		);

		// Both unparseable: Date.parse yields NaN, so the result must still be
		// deterministic rather than depending on which NaN comparison ran first.
		expect(laterIso("not-a-date-b", "not-a-date-a")).toBe("not-a-date-a");
		expect(laterIso("not-a-date-a", "not-a-date-b")).toBe("not-a-date-a");
		// One unparseable side must never beat a real timestamp.
		expect(laterIso("not-a-date", "2026-01-01T00:00:00Z")).toBe(
			"2026-01-01T00:00:00Z",
		);
	});

	it("orders person detail recency sorts deterministically regardless of source order", async () => {
		// Rooms arrive in the reverse of the expected order so a comparator that
		// returns 0 (or NaN) for the tied pair cannot produce the expectation by
		// accident through a stable sort.
		const roomOrder = [ROOM_C, ROOM_B, ROOM_A];
		const roomMessages: Record<string, Memory[]> = {
			[ROOM_A]: [
				{
					id: "aaaaaaaa-6666-4666-8666-666666666666" as UUID,
					entityId: ENTITY_ID,
					roomId: ROOM_A,
					agentId: AGENT_ID,
					createdAt: TIED_AT,
					content: { text: "tied recent A" },
				},
			],
			[ROOM_B]: [
				{
					id: "bbbbbbbb-6666-4666-8666-666666666666" as UUID,
					entityId: ENTITY_ID,
					roomId: ROOM_B,
					agentId: AGENT_ID,
					createdAt: TIED_AT,
					content: { text: "tied recent B" },
				},
			],
			[ROOM_C]: [
				{
					id: "cccccccc-6666-4666-8666-666666666666" as UUID,
					entityId: ENTITY_ID,
					roomId: ROOM_C,
					agentId: AGENT_ID,
					createdAt: Number.NaN,
					content: { text: "unparseable activity" },
				},
			],
		};

		// Facts and relevant memories are also emitted newest-first with the later
		// id first, so only the id tiebreak can reorder them.
		const factMemories: Memory[] = [
			{
				id: FACT_LATE_ID as UUID,
				entityId: ENTITY_ID,
				roomId: ROOM_A,
				agentId: AGENT_ID,
				createdAt: TIED_AT,
				content: { text: "tied fact late id" },
			},
			{
				id: FACT_EARLY_ID as UUID,
				entityId: ENTITY_ID,
				roomId: ROOM_A,
				agentId: AGENT_ID,
				createdAt: TIED_AT,
				content: { text: "tied fact early id" },
			},
		];
		const entityMessages: Memory[] = [
			{
				id: MEMORY_LATE_ID as UUID,
				entityId: ENTITY_ID,
				roomId: ROOM_A,
				agentId: AGENT_ID,
				createdAt: TIED_AT,
				content: { text: "tied memory late id" },
			},
			{
				id: MEMORY_EARLY_ID as UUID,
				entityId: ENTITY_ID,
				roomId: ROOM_A,
				agentId: AGENT_ID,
				createdAt: TIED_AT,
				content: { text: "tied memory early id" },
			},
		];

		const runtime = {
			agentId: AGENT_ID,
			async getAllWorlds() {
				return [];
			},
			async getRoomsByWorlds() {
				return [];
			},
			async getRoomsForParticipants() {
				return roomOrder;
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
				entityId,
			}: {
				tableName: string;
				roomId?: UUID;
				entityId?: UUID;
			}) {
				if (tableName === "facts") {
					return entityId === ENTITY_ID ? factMemories : [];
				}
				if (tableName !== "messages") return [];
				if (roomId) return roomMessages[roomId] ?? [];
				return entityId === ENTITY_ID ? entityMessages : [];
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

		// Tied activity falls back to roomId, and the unparseable timestamp sorts
		// last instead of poisoning the comparator.
		expect(
			detail?.recentConversations.map((snippet) => snippet.roomId),
		).toEqual([ROOM_A, ROOM_B, ROOM_C]);

		expect(detail?.facts.map((fact) => fact.id)).toEqual([
			FACT_EARLY_ID,
			FACT_LATE_ID,
		]);

		expect(detail?.relevantMemories.map((memory) => memory.id)).toEqual([
			MEMORY_EARLY_ID,
			MEMORY_LATE_ID,
		]);
	});
});
