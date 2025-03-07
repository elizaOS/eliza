import { beforeEach, describe, expect, it, test, vi } from "vitest";
import { AgentRuntime } from "../src/runtime";
import {
	ChannelType,
	type Action,
	type IDatabaseAdapter,
	type IMemoryManager,
	type Memory,
	type UUID,
} from "../src/types";

// Mock dependencies with minimal implementations
const mockDatabaseAdapter: IDatabaseAdapter = {
	db: {},
	init: vi.fn().mockResolvedValue(undefined),
	close: vi.fn().mockResolvedValue(undefined),
	getEntityById: vi.fn().mockResolvedValue(null),
	createEntity: vi.fn().mockResolvedValue(true),
	getMemories: vi.fn().mockResolvedValue([]),
	getMemoryById: vi.fn().mockResolvedValue(null),
	getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
	getMemoriesByIds: vi.fn().mockResolvedValue([]),
	getCachedEmbeddings: vi.fn().mockResolvedValue([]),
	log: vi.fn().mockResolvedValue(undefined),
	getActorDetails: vi.fn().mockResolvedValue([]),
	searchMemories: vi.fn().mockResolvedValue([]),
	updateGoalStatus: vi.fn().mockResolvedValue(undefined),
	createMemory: vi.fn().mockResolvedValue(undefined),
	removeMemory: vi.fn().mockResolvedValue(undefined),
	removeAllMemories: vi.fn().mockResolvedValue(undefined),
	countMemories: vi.fn().mockResolvedValue(0),
	getGoals: vi.fn().mockResolvedValue([]),
	updateGoal: vi.fn().mockResolvedValue(undefined),
	createGoal: vi.fn().mockResolvedValue(undefined),
	removeGoal: vi.fn().mockResolvedValue(undefined),
	removeAllGoals: vi.fn().mockResolvedValue(undefined),
	getRoom: vi.fn().mockResolvedValue(null),
	createRoom: vi.fn().mockResolvedValue("test-room-id" as UUID),
	removeRoom: vi.fn().mockResolvedValue(undefined),
	getRoomsForParticipant: vi.fn().mockResolvedValue([]),
	getRoomsForParticipants: vi.fn().mockResolvedValue([]),
	addParticipant: vi.fn().mockResolvedValue(true),
	removeParticipant: vi.fn().mockResolvedValue(true),
	getParticipantsForAccount: vi.fn().mockResolvedValue([]),
	getParticipantsForRoom: vi.fn().mockResolvedValue([]),
	getParticipantUserState: vi.fn().mockResolvedValue(null),
	setParticipantUserState: vi.fn().mockResolvedValue(undefined),
	createRelationship: vi.fn().mockResolvedValue(true),
	getRelationship: vi.fn().mockResolvedValue(null),
	getRelationships: vi.fn().mockResolvedValue([]),
};

const mockCacheManager = {
	get: vi.fn().mockResolvedValue(null),
	set: vi.fn().mockResolvedValue(undefined),
	delete: vi.fn().mockResolvedValue(undefined),
};

// Mock action creator
const createMockAction = (name: string): Action => ({
	name,
	description: `Test action ${name}`,
	similes: [`like ${name}`],
	examples: [],
	handler: vi.fn().mockResolvedValue(undefined),
	validate: vi.fn().mockImplementation(async () => true),
});

describe("AgentRuntime", () => {
	let runtime: AgentRuntime;

	beforeEach(() => {
		vi.clearAllMocks();

		runtime = new AgentRuntime({
			character: {
				name: "Test Character",
				username: "test",
				bio: ["Test bio"],
				messageExamples: [],
				postExamples: [],
				topics: [],
				adjectives: [],
				style: {
					all: [],
					chat: [],
					post: [],
				},
			},
			databaseAdapter: mockDatabaseAdapter,
			cacheManager: mockCacheManager,
		});
	});

	describe("memory manager service", () => {
		it("should provide access to different memory managers", () => {
			expect(runtime.messageManager).toBeDefined();
			expect(runtime.descriptionManager).toBeDefined();
			expect(runtime.documentsManager).toBeDefined();
			expect(runtime.knowledgeManager).toBeDefined();
		});

		it("should allow registering custom memory managers", () => {
			const customManager: IMemoryManager = {
				runtime: runtime,
				tableName: "custom",
				getMemories: vi.fn(),
				searchMemories: vi.fn(),
				getCachedEmbeddings: vi.fn(),
				getMemoryById: vi.fn(),
				getMemoriesByRoomIds: vi.fn(),
				createMemory: vi.fn(),
				removeMemory: vi.fn(),
				removeAllMemories: vi.fn(),
				countMemories: vi.fn(),
				addEmbeddingToMemory: vi.fn(),
			};
			runtime.registerMemoryManager(customManager);
			expect(runtime.getMemoryManager("custom")).toBe(customManager);
		});
	});

	describe("model provider management", () => {
		it("should provide access to the configured model provider", () => {
			const provider = runtime;
			expect(provider).toBeDefined();
		});
	});

	describe("state management", () => {
		it("should compose state with additional keys", async () => {
			const message: Memory = {
				id: "123e4567-e89b-12d3-a456-426614174003",
				userId: "123e4567-e89b-12d3-a456-426614174004",
				agentId: "123e4567-e89b-12d3-a456-426614174005",
				roomId: "123e4567-e89b-12d3-a456-426614174003",
				content: { type: "text", text: "test message" },
			};

			const additionalKeys = {
				customKey: "customValue",
			};

			const state = await runtime.composeState(message, additionalKeys);
			expect(state).toHaveProperty("customKey", "customValue");
			expect(state).toHaveProperty("roomId");
			expect(state).toHaveProperty("actors");
			expect(state).toHaveProperty("recentMessages");
		});
	});

	describe("action management", () => {
		it("should register an action", () => {
			const action = createMockAction("testAction");
			runtime.registerAction(action);
			expect(runtime.actions).toContain(action);
		});

		it("should allow registering multiple actions", () => {
			const action1 = createMockAction("testAction1");
			const action2 = createMockAction("testAction2");
			runtime.registerAction(action1);
			runtime.registerAction(action2);
			expect(runtime.actions).toContain(action1);
			expect(runtime.actions).toContain(action2);
		});
	});
});

describe("MemoryManagerService", () => {
	test("should provide access to different memory managers", async () => {
		const runtime = new AgentRuntime({
			databaseAdapter: mockDatabaseAdapter,
			cacheManager: mockCacheManager,
		});

		expect(runtime.messageManager).toBeDefined();
		expect(runtime.descriptionManager).toBeDefined();
		expect(runtime.documentsManager).toBeDefined();
		expect(runtime.knowledgeManager).toBeDefined();
	});

	test("should allow registering custom memory managers", async () => {
		const runtime = new AgentRuntime({
			databaseAdapter: mockDatabaseAdapter,
			cacheManager: mockCacheManager,
		});

		const customManager: IMemoryManager = {
			runtime: runtime,
			tableName: "custom",
			getMemories: vi.fn(),
			searchMemories: vi.fn(),
			getCachedEmbeddings: vi.fn(),
			getMemoryById: vi.fn(),
			getMemoriesByRoomIds: vi.fn(),
			createMemory: vi.fn(),
			removeMemory: vi.fn(),
			removeAllMemories: vi.fn(),
			countMemories: vi.fn(),
			addEmbeddingToMemory: vi.fn(),
		};

		runtime.registerMemoryManager(customManager);
		expect(runtime.getMemoryManager("custom")).toBe(customManager);
	});
});
