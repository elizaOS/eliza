/**
 * @fileoverview Runtime Integration Tests with Mocked Infrastructure
 *
 * These tests verify runtime functionality using mocked database adapters.
 * NO external infrastructure required - all tests run with in-memory mocks.
 */

import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../../runtime";
import type {
	Agent,
	Character,
	Entity,
	IAgentRuntime,
	IDatabaseAdapter,
	Memory,
	Room,
	Task,
	UUID,
	World,
} from "../../types";
import { stringToUuid } from "../../utils";

/**
 * Creates a comprehensive mock database adapter for testing
 */
function createMockDatabaseAdapter(_agentId: UUID): IDatabaseAdapter {
	// In-memory storage
	const agents = new Map<string, Partial<Agent>>();
	const memories = new Map<UUID, Memory>();
	const rooms = new Map<UUID, Room>();
	const worlds = new Map<UUID, World>();
	const entities = new Map<UUID, Entity>();
	const tasks = new Map<UUID, Task>();
	const cache = new Map<string, unknown>();
	const participants = new Map<UUID, Set<UUID>>(); // roomId -> entityIds

	return {
		db: {},
		init: vi.fn().mockResolvedValue(undefined),
		initialize: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		getConnection: vi.fn().mockResolvedValue({}),
		isReady: vi.fn().mockResolvedValue(true),

		// Agent methods
		getAgentsByIds: vi.fn(
			async (ids: UUID[]) =>
				ids
					.map((id) => agents.get(String(id)))
					.filter(
						(a): a is Partial<Agent> => a != null && a.id != null,
					) as Agent[],
		),
		getAgents: vi.fn(async () => Array.from(agents.values())),
		createAgents: vi.fn(async (agentsToCreate: Partial<Agent>[]) => {
			const ids: UUID[] = [];
			for (const agent of agentsToCreate) {
				if (agent.id) {
					agents.set(String(agent.id), agent);
					ids.push(agent.id);
				}
			}
			return ids;
		}),
		upsertAgents: vi.fn(async (agentsToUpsert: Partial<Agent>[]) => {
			for (const agent of agentsToUpsert) {
				if (agent.id) agents.set(String(agent.id), agent);
			}
		}),
		updateAgents: vi.fn().mockResolvedValue(true),
		deleteAgents: vi.fn().mockResolvedValue(true),
		ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),

		// Memory methods
		getMemories: vi.fn(async (params: { roomId?: UUID; tableName: string }) => {
			const result: Memory[] = [];
			for (const mem of memories.values()) {
				if (!params.roomId || mem.roomId === params.roomId) {
					result.push(mem);
				}
			}
			return result;
		}),
		getMemoriesByIds: vi.fn(
			async (ids: UUID[]) =>
				ids.map((id) => memories.get(id)).filter(Boolean) as Memory[],
		),
		getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
		getCachedEmbeddings: vi.fn().mockResolvedValue([]),
		searchMemories: vi.fn().mockResolvedValue([]),
		createMemories: vi.fn(
			async (
				batch: Array<{ memory: Memory; tableName: string; unique?: boolean }>,
			) => {
				const ids: UUID[] = [];
				for (const { memory } of batch) {
					const id = memory.id || (stringToUuid(uuidv4()) as UUID);
					memories.set(id, { ...memory, id });
					ids.push(id);
				}
				return ids;
			},
		),
		updateMemories: vi.fn().mockResolvedValue([true]),
		deleteMemories: vi.fn(async (ids: UUID[]) => {
			for (const id of ids) {
				memories.delete(id);
			}
		}),
		deleteAllMemories: vi.fn().mockResolvedValue(undefined),
		countMemories: vi.fn().mockResolvedValue(0),
		getMemoriesByWorldId: vi.fn().mockResolvedValue([]),

		// Entity methods
		getEntitiesByIds: vi.fn(
			async (ids: UUID[]) =>
				ids.map((id) => entities.get(id)).filter(Boolean) as Entity[],
		),
		getEntitiesForRoom: vi.fn().mockResolvedValue([]),
		getEntitiesForRooms: vi.fn(async (roomIds: UUID[]) => {
			return roomIds.map((roomId) => {
				const roomParticipants = participants.get(roomId);
				const entitiesForRoom: Entity[] = [];
				if (roomParticipants) {
					for (const entityId of roomParticipants) {
						const entity = entities.get(entityId);
						if (entity) entitiesForRoom.push(entity);
					}
				}
				return { roomId, entities: entitiesForRoom };
			});
		}),
		createEntities: vi.fn(async (newEntities: Entity[]) => {
			const ids: UUID[] = [];
			for (const entity of newEntities) {
				const id = entity.id || (stringToUuid(uuidv4()) as UUID);
				entities.set(id, { ...entity, id });
				ids.push(id);
			}
			return ids;
		}),
		updateEntities: vi.fn().mockResolvedValue(undefined),
		deleteEntities: vi.fn().mockResolvedValue(undefined),

		// Component methods
		getComponent: vi.fn().mockResolvedValue(null),
		getComponents: vi.fn().mockResolvedValue([]),
		createComponents: vi.fn().mockResolvedValue(true),
		getComponentsByIds: vi.fn().mockResolvedValue([]),
		updateComponents: vi.fn().mockResolvedValue(undefined),
		deleteComponents: vi.fn().mockResolvedValue(undefined),

		// Room methods
		getRoomsByIds: vi.fn(
			async (ids: UUID[]) =>
				ids.map((id) => rooms.get(id)).filter(Boolean) as Room[],
		),
		createRooms: vi.fn(async (newRooms: Room[]) => {
			const ids: UUID[] = [];
			for (const room of newRooms) {
				const id = room.id || (stringToUuid(uuidv4()) as UUID);
				rooms.set(id, { ...room, id });
				participants.set(id, new Set());
				ids.push(id);
			}
			return ids;
		}),
		updateRooms: vi.fn().mockResolvedValue(undefined),
		upsertRooms: vi.fn(async (roomsToUpsert: Room[]) => {
			for (const room of roomsToUpsert) {
				if (room.id) {
					rooms.set(room.id, { ...room, id: room.id });
					if (!participants.has(room.id)) {
						participants.set(room.id, new Set());
					}
				}
			}
		}),
		deleteRooms: vi.fn(async (ids: UUID[]) => {
			for (const id of ids) {
				rooms.delete(id);
				participants.delete(id);
			}
		}),
		deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
		getRoomsForParticipant: vi.fn().mockResolvedValue([]),
		getRoomsForParticipants: vi.fn().mockResolvedValue([]),
		getRoomsByWorld: vi.fn(async (worldId: UUID) => {
			const result: Room[] = [];
			for (const room of rooms.values()) {
				if (room.worldId === worldId) {
					result.push(room);
				}
			}
			return result;
		}),
		getRoomsByWorlds: vi.fn(async (worldIds: UUID[]) => {
			const result: Room[] = [];
			for (const room of rooms.values()) {
				if (room.worldId && worldIds.includes(room.worldId)) {
					result.push(room);
				}
			}
			return result;
		}),

		// Participant methods
		createRoomParticipants: vi.fn(async (entityIds: UUID[], roomId: UUID) => {
			let roomParticipants = participants.get(roomId);
			if (!roomParticipants) {
				roomParticipants = new Set();
				participants.set(roomId, roomParticipants);
			}
			for (const id of entityIds) {
				roomParticipants.add(id);
			}
			return entityIds;
		}),
		deleteParticipants: vi.fn().mockResolvedValue(true),
		getParticipantsForEntity: vi.fn().mockResolvedValue([]),
		getParticipantsForRoom: vi.fn(async (roomId: UUID) => {
			const roomParticipants = participants.get(roomId);
			return roomParticipants ? Array.from(roomParticipants) : [];
		}),
		getParticipantsForRooms: vi.fn(async (roomIds: UUID[]) => {
			return roomIds.map((roomId) => {
				const roomParticipants = participants.get(roomId);
				return {
					roomId,
					entityIds: roomParticipants ? Array.from(roomParticipants) : [],
				};
			});
		}),
		isRoomParticipant: vi.fn().mockResolvedValue(false),
		getParticipantUserState: vi.fn().mockResolvedValue(null),
		getParticipantUserStates: vi.fn(
			async (pairs: Array<{ roomId: UUID; entityId: UUID }>) =>
				pairs.map(() => null),
		),
		updateParticipantUserState: vi.fn().mockResolvedValue(undefined),
		setParticipantUserState: vi.fn().mockResolvedValue(undefined),

		// World methods
		createWorlds: vi.fn(async (worldsToCreate: World[]) => {
			const ids: UUID[] = [];
			for (const world of worldsToCreate) {
				const id = world.id || (stringToUuid(uuidv4()) as UUID);
				worlds.set(id, { ...world, id });
				ids.push(id);
			}
			return ids;
		}),
		getWorldsByIds: vi.fn(
			async (ids: UUID[]) =>
				ids.map((id) => worlds.get(id)).filter(Boolean) as World[],
		),
		deleteWorlds: vi.fn(async (ids: UUID[]) => {
			for (const id of ids) {
				worlds.delete(id);
			}
		}),
		getAllWorlds: vi.fn(async () => Array.from(worlds.values())),
		updateWorlds: vi.fn(async (worldsToUpdate: World[]) => {
			for (const world of worldsToUpdate) {
				if (world.id) {
					worlds.set(world.id, world);
				}
			}
		}),

		// Relationship methods
		getRelationship: vi.fn().mockResolvedValue(null),
		getRelationships: vi.fn().mockResolvedValue([]),
		createRelationships: vi.fn().mockResolvedValue(true),
		getRelationshipsByIds: vi.fn().mockResolvedValue([]),
		updateRelationships: vi.fn().mockResolvedValue(undefined),
		deleteRelationships: vi.fn().mockResolvedValue(undefined),

		// Cache methods
		getCaches: vi.fn(async <T>(keys: string[]) => {
			const result = new Map<string, T>();
			for (const key of keys) {
				const value = cache.get(key) as T | undefined;
				if (value !== undefined) result.set(key, value);
			}
			return result;
		}),
		setCaches: vi.fn(async <T>(entries: Array<{ key: string; value: T }>) => {
			for (const { key, value } of entries) cache.set(key, value);
			return true;
		}),
		deleteCaches: vi.fn(async (keys: string[]) => {
			for (const key of keys) cache.delete(key);
			return true;
		}),

		// Task methods
		getTasks: vi.fn().mockResolvedValue([]),
		getTasksByName: vi.fn().mockResolvedValue([]),
		createTasks: vi.fn(async (tasksToCreate: Task[]) => {
			const ids: UUID[] = [];
			for (const task of tasksToCreate) {
				const id = task.id || (stringToUuid(uuidv4()) as UUID);
				tasks.set(id, { ...task, id });
				ids.push(id);
			}
			return ids;
		}),
		getTasksByIds: vi.fn(
			async (ids: UUID[]) =>
				ids.map((id) => tasks.get(id)).filter(Boolean) as Task[],
		),
		updateTasks: vi.fn().mockResolvedValue(undefined),
		deleteTasks: vi.fn(async (ids: UUID[]) => {
			for (const id of ids) tasks.delete(id);
		}),

		// Log methods
		getLogs: vi.fn().mockResolvedValue([]),
		createLogs: vi.fn().mockResolvedValue(undefined),
		deleteLogs: vi.fn().mockResolvedValue(undefined),
		getAgentRunSummaries: vi
			.fn()
			.mockResolvedValue({ runs: [], totalCount: 0 }),

		// Pairing methods
		getPairingRequests: vi.fn().mockResolvedValue([]),
		getPairingAllowlist: vi.fn().mockResolvedValue([]),
		createPairingRequests: vi.fn().mockResolvedValue([]),
		updatePairingRequests: vi.fn().mockResolvedValue(undefined),
		deletePairingRequests: vi.fn().mockResolvedValue(undefined),
		createPairingAllowlistEntries: vi.fn().mockResolvedValue([]),
		deletePairingAllowlistEntries: vi.fn().mockResolvedValue(undefined),
	} as IDatabaseAdapter;
}

describe("Integration Tests with Mocked Infrastructure", () => {
	let runtime: IAgentRuntime;
	let agentId: UUID;

	const testCharacter: Character = {
		name: "IntegrationTestAgent",
		system: "You are a helpful assistant for integration testing.",
		bio: ["Integration test agent"],
		templates: {},
		messageExamples: [],
		postExamples: [],
		topics: ["testing"],
		adjectives: [],
		knowledge: [],
		plugins: [],
		secrets: {},
		settings: {},
	};

	beforeAll(async () => {
		agentId = uuidv4() as UUID;
		testCharacter.id = agentId;

		const mockAdapter = createMockDatabaseAdapter(agentId);

		runtime = new AgentRuntime({
			agentId,
			character: testCharacter,
			adapter: mockAdapter,
		});

		await runtime.initialize();
	});

	afterAll(async () => {
		await runtime.stop();
	});

	describe("Database Operations", () => {
		it("should create and retrieve a memory", async () => {
			const roomId = stringToUuid(`test-room-${uuidv4()}`);

			const memory: Memory = {
				id: stringToUuid(`message-${uuidv4()}`),
				entityId: agentId,
				roomId,
				content: {
					text: "Hello, this is a test message",
					source: "integration-test",
				},
				createdAt: Date.now(),
			};

			// Create memory
			const memoryId = await runtime.createMemory(memory, "messages");
			expect(memoryId).toBeDefined();

			// Retrieve memories
			const memories = await runtime.getMemories({
				roomId,
				count: 10,
				tableName: "messages",
			});

			expect(memories.length).toBeGreaterThan(0);
			const found = memories.find((m) => m.id === memory.id);
			expect(found).toBeDefined();
			const foundContent = found?.content;
			expect(foundContent?.text).toBe("Hello, this is a test message");
		});

		it("should create a room and add participants", async () => {
			const roomId = stringToUuid(`test-room-${uuidv4()}`);
			const entityId = stringToUuid(`test-entity-${uuidv4()}`);

			// Create a world first (required for rooms)
			const worldId = await runtime.createWorld({
				name: "Test World for Room",
				agentId,
			});

			// Ensure room exists
			await runtime.ensureRoomExists({
				id: roomId,
				name: "Test Room",
				source: "integration-test",
				type: "GROUP",
				worldId,
			});

			// Add participant
			const added = await runtime.addParticipant(entityId, roomId);
			expect(added).toBe(true);

			// Verify participant
			const participants = await runtime.getParticipantsForRoom(roomId);
			expect(participants).toContain(entityId);
		});

		it("should handle world and room relationships", async () => {
			const worldId = await runtime.createWorld({
				name: "Test World",
				agentId,
			});
			expect(worldId).toBeDefined();

			const roomId = stringToUuid(`test-room-${uuidv4()}`);
			await runtime.ensureRoomExists({
				id: roomId,
				name: "Room in World",
				source: "integration-test",
				type: "GROUP",
				worldId,
			});

			// Get rooms for world
			const rooms = await runtime.getRoomsByWorld(worldId);
			expect(rooms.length).toBeGreaterThan(0);
		});
	});

	describe("Entity Management", () => {
		it("should create and retrieve an entity", async () => {
			const entityId = stringToUuid(`entity-${uuidv4()}`);

			await runtime.createEntity({
				id: entityId,
				names: ["Test Entity"],
				agentId,
				metadata: { testKey: "testValue" },
			});

			const entity = await runtime.getEntityById(entityId);
			expect(entity).toBeDefined();
			expect(entity?.names).toContain("Test Entity");
		});
	});

	describe("Cache Operations", () => {
		it("should set and get cache values", async () => {
			const cacheKey = `test-cache-${uuidv4()}`;
			const cacheValue = { data: "test data", timestamp: Date.now() };

			await runtime.setCache(cacheKey, cacheValue);

			const retrieved = await runtime.getCache<typeof cacheValue>(cacheKey);
			expect(retrieved).toBeDefined();
			expect(retrieved?.data).toBe("test data");
		});
	});

	describe("Task Management", () => {
		it("should create and retrieve a task", async () => {
			const roomId = stringToUuid(`test-room-${uuidv4()}`);

			const taskId = await runtime.createTask({
				name: "Test Task",
				roomId,
				worldId: agentId,
				metadata: { priority: "high" },
				tags: ["test"],
			});

			expect(taskId).toBeDefined();

			const task = await runtime.getTask(taskId);
			expect(task).toBeDefined();
			expect(task?.name).toBe("Test Task");
		});
	});
});

/**
 * Tests for inference functionality using mock model handlers
 */
describe("Inference Tests with Mock Handlers", () => {
	let runtime: AgentRuntime;
	let agentId: UUID;

	const testCharacter: Character = {
		name: "InferenceTestAgent",
		system: "You are a helpful assistant.",
		bio: ["Test agent for inference"],
		templates: {},
		messageExamples: [],
		postExamples: [],
		topics: [],
		adjectives: [],
		knowledge: [],
		plugins: [],
		secrets: {},
	};

	beforeAll(async () => {
		agentId = uuidv4() as UUID;
		testCharacter.id = agentId;

		const mockAdapter = createMockDatabaseAdapter(agentId);

		runtime = new AgentRuntime({
			agentId,
			character: testCharacter,
			adapter: mockAdapter,
		});

		// Register mock model handler
		runtime.registerModel(
			"TEXT_LARGE",
			async (_rt, params) => {
				const textParams = params as { prompt: string };
				return `Mock response to: ${textParams.prompt}`;
			},
			"mock-provider",
		);

		await runtime.initialize();
	});

	afterAll(async () => {
		await runtime.stop();
	});

	it("should generate text using mock model handler", async () => {
		const response = await runtime.useModel("TEXT_LARGE", {
			prompt: "Say hello",
		});

		expect(response).toBeDefined();
		expect(response).toBe("Mock response to: Say hello");
	});
});
