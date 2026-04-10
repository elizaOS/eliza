import { describe, expect, it, vi } from "vitest";
import { relationshipsProvider } from "../advanced-capabilities/providers/relationships.ts";
import {
	RelationshipsService,
	calculateRelationshipStrength,
	countSharedConversationWindows,
} from "../services/relationships.ts";
import type { Entity, Relationship } from "../types/environment.ts";
import type { Memory } from "../types/memory.ts";
import type { IAgentRuntime, UUID } from "../types/runtime.ts";
import { stringToUuid } from "../utils.ts";

type MockRuntime = IAgentRuntime & {
	agentId: UUID;
	character: { name: string };
	ensureWorldExists: ReturnType<typeof vi.fn>;
	ensureRoomExists: ReturnType<typeof vi.fn>;
	queryEntities: ReturnType<typeof vi.fn>;
	getRooms: ReturnType<typeof vi.fn>;
	getEntitiesForRoom: ReturnType<typeof vi.fn>;
	getComponents: ReturnType<typeof vi.fn>;
	getRelationships: ReturnType<typeof vi.fn>;
	getRoomsForParticipant: ReturnType<typeof vi.fn>;
	getMemoriesByRoomIds: ReturnType<typeof vi.fn>;
	createComponent: ReturnType<typeof vi.fn>;
	getEntityById: ReturnType<typeof vi.fn>;
};

const agentId = stringToUuid("relationships-analytics-agent");
const ownerId = stringToUuid("relationships-analytics-owner");
const adaId = stringToUuid("relationships-analytics-ada");
const miraId = stringToUuid("relationships-analytics-mira");
const sharedRoomId = stringToUuid("relationships-analytics-shared-room");
const otherRoomId = stringToUuid("relationships-analytics-other-room");
const leftEntityId = "91000000-0000-0000-0000-000000000101" as UUID;
const rightEntityId = "91000000-0000-0000-0000-000000000102" as UUID;
const analyticsRoomId = "91000000-0000-0000-0000-000000000103" as UUID;
const analyticsAgentId = "91000000-0000-0000-0000-000000000104" as UUID;

function createRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
	return {
		agentId,
		character: { name: "Relationships Test Agent" },
		ensureWorldExists: vi.fn().mockResolvedValue(undefined),
		ensureRoomExists: vi.fn().mockResolvedValue(undefined),
		queryEntities: vi.fn().mockResolvedValue([]),
		getRooms: vi.fn().mockResolvedValue([]),
		getEntitiesForRoom: vi.fn().mockResolvedValue([]),
		getComponents: vi.fn().mockResolvedValue([]),
		getRelationships: vi.fn().mockResolvedValue([]),
		getRoomsForParticipant: vi.fn().mockResolvedValue([]),
		getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
		createComponent: vi.fn().mockResolvedValue(true),
		getEntityById: vi.fn().mockResolvedValue(null),
		...overrides,
	} as unknown as MockRuntime;
}

function createMessage(entityId: UUID): Memory {
	return {
		id: stringToUuid(`message-${entityId}`),
		entityId,
		roomId: sharedRoomId,
		content: {
			text: "show relationships",
			senderName: "User",
		},
	};
}

describe("relationships analytics and provider", () => {
	it("analyzes bidirectional interactions from shared rooms and updates last contact", async () => {
		const relationship = {
			id: stringToUuid("relationship-analytics"),
			sourceEntityId: ownerId,
			targetEntityId: adaId,
			metadata: {},
		} as Relationship;
		const runtime = createRuntime({
			getRelationships: vi.fn().mockResolvedValue([relationship]),
			getRoomsForParticipant: vi.fn(async (entityId: UUID) => {
				if (entityId === ownerId) {
					return [sharedRoomId, otherRoomId];
				}
				if (entityId === adaId) {
					return [sharedRoomId];
				}
				return [];
			}),
			getMemoriesByRoomIds: vi.fn().mockResolvedValue([
				{
					id: stringToUuid("memory-one"),
					roomId: sharedRoomId,
					entityId: ownerId,
					content: { text: "Morning" },
					createdAt: 1_000,
				},
				{
					id: stringToUuid("memory-two"),
					roomId: sharedRoomId,
					entityId: adaId,
					content: { text: "Hi Ada" },
					createdAt: 2_000,
				},
				{
					id: stringToUuid("memory-three"),
					roomId: sharedRoomId,
					entityId: ownerId,
					content: { text: "Project Apollo" },
					createdAt: 3_000,
				},
			]),
		});
		const service = new RelationshipsService();

		await service.initialize(runtime);
		const analytics = await service.analyzeRelationship(ownerId, adaId);

		expect(runtime.getRoomsForParticipant).toHaveBeenCalledTimes(2);
		expect(runtime.getMemoriesByRoomIds).toHaveBeenCalledWith({
			tableName: "messages",
			roomIds: [sharedRoomId],
			limit: 200,
		});
		expect(analytics).toMatchObject({
			interactionCount: 3,
			lastInteractionAt: new Date(3_000).toISOString(),
			averageResponseTime: 1_000,
		});
		expect(analytics?.topicsDiscussed).toEqual(
			expect.arrayContaining(["Project", "Apollo"]),
		);
		expect(runtime.createComponent).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "relationship_update",
				data: expect.objectContaining({
					targetEntityId: adaId,
					lastInteractionAt: new Date(3_000).toISOString(),
				}),
			}),
		);
	});

	it("formats reverse-direction relationships using the counterpart entity", async () => {
		const reverseRelationship = {
			id: stringToUuid("reverse-relationship"),
			sourceEntityId: adaId,
			targetEntityId: ownerId,
			tags: ["friend"],
			metadata: { interactions: 8 },
		} as Relationship;
		const forwardRelationship = {
			id: stringToUuid("forward-relationship"),
			sourceEntityId: ownerId,
			targetEntityId: miraId,
			tags: ["colleague"],
			metadata: { interactions: 5 },
		} as Relationship;
		const entities = new Map<UUID, Entity>([
			[
				adaId,
				{
					id: adaId,
					names: ["Ada"],
				} as Entity,
			],
			[
				miraId,
				{
					id: miraId,
					names: ["Mira"],
				} as Entity,
			],
			[
				ownerId,
				{
					id: ownerId,
					names: ["Owner"],
				} as Entity,
			],
		]);
		const runtime = createRuntime({
			getRelationships: vi
				.fn()
				.mockResolvedValue([reverseRelationship, forwardRelationship]),
			getEntityById: vi.fn(
				async (entityId: UUID) => entities.get(entityId) ?? null,
			),
		});

		const result = await relationshipsProvider.get(
			runtime,
			createMessage(ownerId),
		);

		expect(result.text).toContain("Ada");
		expect(result.text).toContain("Mira");
		expect(result.text).not.toContain("Owner aka");
	});
});

describe("shared conversation heuristics", () => {
	it("counts shared conversation windows per room within one hour", () => {
		const baseTime = Date.now();
		const windows = countSharedConversationWindows(
			[
				{
					roomId: analyticsRoomId,
					entityId: leftEntityId,
					createdAt: baseTime,
				},
				{
					roomId: analyticsRoomId,
					entityId: rightEntityId,
					createdAt: baseTime + 30 * 60 * 1000,
				},
				{
					roomId: analyticsRoomId,
					entityId: leftEntityId,
					createdAt: baseTime + 50 * 60 * 1000,
				},
				{
					roomId: analyticsRoomId,
					entityId: rightEntityId,
					createdAt: baseTime + 75 * 60 * 1000,
				},
				{
					roomId: analyticsRoomId,
					entityId: leftEntityId,
					createdAt: baseTime + 120 * 60 * 1000,
				},
				{
					roomId: analyticsRoomId,
					entityId: rightEntityId,
					createdAt: baseTime + 130 * 60 * 1000,
				},
			],
			leftEntityId,
			rightEntityId,
		);

		expect(windows).toBe(2);
	});

	it("uses shared conversation windows as a relationship-strength bonus", () => {
		const baseline = calculateRelationshipStrength({
			interactionCount: 4,
			lastInteractionAt: new Date().toISOString(),
			relationshipType: "acquaintance",
		});
		const strengthened = calculateRelationshipStrength({
			interactionCount: 4,
			lastInteractionAt: new Date().toISOString(),
			relationshipType: "acquaintance",
			sharedConversationWindows: 3,
		});

		expect(strengthened).toBeGreaterThan(baseline);
	});

	it("analyzes shared chat even when no explicit relationship edge exists", async () => {
		const baseTime = Date.now();
		const runtime = {
			agentId: analyticsAgentId,
			getRelationships: vi.fn().mockResolvedValue([]),
			getRoomsForParticipant: vi.fn().mockResolvedValue([analyticsRoomId]),
			getMemoriesByRoomIds: vi.fn().mockResolvedValue([
				{
					id: "msg-1",
					roomId: analyticsRoomId,
					entityId: leftEntityId,
					createdAt: baseTime,
					content: { text: "hey" },
				},
				{
					id: "msg-2",
					roomId: analyticsRoomId,
					entityId: rightEntityId,
					createdAt: baseTime + 20 * 60 * 1000,
					content: { text: "hi" },
				},
				{
					id: "msg-3",
					roomId: analyticsRoomId,
					entityId: leftEntityId,
					createdAt: baseTime + 35 * 60 * 1000,
					content: { text: "sync later?" },
				},
				{
					id: "msg-4",
					roomId: analyticsRoomId,
					entityId: rightEntityId,
					createdAt: baseTime + 50 * 60 * 1000,
					content: { text: "yes" },
				},
			]),
			createComponent: vi.fn(),
		} as unknown as IAgentRuntime;

		const service = new RelationshipsService();
		service.runtime = runtime;

		const analytics = await service.analyzeRelationship(
			leftEntityId,
			rightEntityId,
		);

		expect(analytics).toMatchObject({
			interactionCount: 4,
			sharedConversationWindows: 1,
		});
		expect(analytics?.strength ?? 0).toBeGreaterThan(0);
		expect(runtime.createComponent).not.toHaveBeenCalled();
	});
});
