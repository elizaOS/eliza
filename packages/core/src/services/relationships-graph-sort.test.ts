/**
 * Verifies safe sort comparator behavior in relationships graph builder
 * when facts, messages, and memories contain invalid or unparseable date strings.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../types/index";
import { createNativeRelationshipsGraphService } from "./relationships-graph-builder";

const AGENT_ID = "11111111-1111-4111-8111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-4222-8222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-4333-8333-333333333333" as UUID;

function createMockRuntime(memories: Record<string, Memory[]>): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		async getAllWorlds() {
			return [];
		},
		async getRoomsByWorlds() {
			return [];
		},
		async getRoomsForParticipants() {
			return [ROOM_ID];
		},
		async getRoomsByIds(roomIds: UUID[]) {
			return roomIds.map((id) => ({ id, name: "Test Room" }));
		},
		async getEntitiesForRoom() {
			return [];
		},
		async getRelationships() {
			return [];
		},
		async getEntityById(id: UUID) {
			if (id === ENTITY_ID) {
				return {
					id: ENTITY_ID,
					names: ["Alice"],
					metadata: {},
				};
			}
			return null;
		},
		async getMemories({ tableName }: { tableName: string }) {
			return memories[tableName] ?? [];
		},
		getService() {
			return null;
		},
	} as unknown as IAgentRuntime;
}

describe("relationships-graph-builder safe sort comparators", () => {
	it("sorts facts safely when updatedAt contains invalid date strings", async () => {
		const factMemories: Memory[] = [
			{
				id: "fact-invalid" as UUID,
				entityId: ENTITY_ID,
				roomId: ROOM_ID,
				agentId: AGENT_ID,
				createdAt: 0,
				content: {
					text: "Alice lives in Wonderland",
				},
				metadata: {
					type: "fact",
				},
			},
			{
				id: "fact-valid-recent" as UUID,
				entityId: ENTITY_ID,
				roomId: ROOM_ID,
				agentId: AGENT_ID,
				createdAt: Date.parse("2026-08-20T00:00:00.000Z"),
				content: {
					text: "Alice loves tea",
				},
				metadata: {
					type: "fact",
				},
			},
		];

		const runtime = createMockRuntime({
			facts: factMemories,
			messages: [],
		});

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
		expect(detail?.facts).toHaveLength(2);
		expect(detail?.facts[0]?.text).toBe("Alice loves tea");
		expect(detail?.facts[1]?.text).toBe("Alice lives in Wonderland");
	});

	it("sorts relevant memories safely when createdAt contains invalid date strings", async () => {
		const messageMemories: Memory[] = [
			{
				id: "msg-invalid" as UUID,
				entityId: ENTITY_ID,
				roomId: ROOM_ID,
				agentId: AGENT_ID,
				createdAt: NaN,
				content: {
					text: "Unparseable date message",
				},
			},
			{
				id: "msg-valid" as UUID,
				entityId: ENTITY_ID,
				roomId: ROOM_ID,
				agentId: AGENT_ID,
				createdAt: 1770000000000,
				content: {
					text: "Valid date message",
				},
			},
		];

		const runtime = createMockRuntime({
			facts: [],
			messages: messageMemories,
		});

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
		expect(detail?.relevantMemories).toHaveLength(2);
		expect(detail?.relevantMemories[0]?.text).toBe("Valid date message");
		expect(detail?.relevantMemories[1]?.text).toBe("Unparseable date message");
	});
});
