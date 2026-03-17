import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, IDatabaseAdapter, Memory, UUID } from "../types";
import { MemoryType } from "../types";

const stringToUuid = (id: string): UUID => id as UUID;

// Track adapter readiness across init/close
let adapterReady = false;

// Mock IDatabaseAdapter (minimal for these tests)
const createMockDatabaseAdapter = (): IDatabaseAdapter =>
	({
		isRoomParticipant: vi.fn().mockResolvedValue(true),
		db: {},
		init: vi.fn().mockImplementation(async () => {
			adapterReady = true;
		}),
		initialize: vi.fn().mockResolvedValue(undefined),
		isReady: vi.fn().mockImplementation(async () => adapterReady),
		close: vi.fn().mockImplementation(async () => {
			adapterReady = false;
		}),
		getConnection: vi.fn().mockResolvedValue({}),
		getEntitiesByIds: vi.fn().mockResolvedValue([]),
		createEntities: vi.fn().mockResolvedValue(true),
		getMemories: vi.fn().mockResolvedValue([]),
		getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
		getMemoriesByIds: vi.fn().mockResolvedValue([]),
		getCachedEmbeddings: vi.fn().mockResolvedValue([]),
		createLogs: vi.fn().mockResolvedValue(undefined),
		searchMemories: vi.fn().mockResolvedValue([]),
		createMemories: vi.fn().mockResolvedValue([]),
		deleteMemories: vi.fn().mockResolvedValue(undefined),
		deleteManyMemories: vi.fn().mockResolvedValue(undefined),
		deleteAllMemories: vi.fn().mockResolvedValue(undefined),
		countMemories: vi.fn().mockResolvedValue(0),
		getRoomsByIds: vi.fn().mockResolvedValue([]),
		createRooms: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
		deleteRooms: vi.fn().mockResolvedValue(undefined),
		getRoomsForParticipant: vi.fn().mockResolvedValue([]),
		getRoomsForParticipants: vi.fn().mockResolvedValue([]),
		createRoomParticipants: vi.fn().mockResolvedValue([]),
		deleteParticipants: vi.fn().mockResolvedValue(true),
		getParticipantsForEntity: vi.fn().mockResolvedValue([]),
		getParticipantsForRoom: vi.fn().mockResolvedValue([]),
		getParticipantUserState: vi.fn().mockResolvedValue(null),
		updateParticipantUserState: vi.fn().mockResolvedValue(undefined),
		createRelationships: vi.fn().mockResolvedValue(true),
		getRelationshipsByIds: vi.fn().mockResolvedValue([]),
		getRelationship: vi.fn().mockResolvedValue(null),
		getRelationships: vi.fn().mockResolvedValue([]),
		getEntityById: vi.fn().mockResolvedValue(null),
		createEntity: vi.fn().mockResolvedValue(true),
		updateEntities: vi.fn().mockResolvedValue(undefined),
		deleteEntities: vi.fn().mockResolvedValue(undefined),
		createWorlds: vi.fn().mockResolvedValue([]),
		getWorldsByIds: vi.fn().mockResolvedValue([]),
		getWorlds: vi.fn().mockResolvedValue([]),
		updateWorlds: vi.fn().mockResolvedValue(undefined),
		deleteWorlds: vi.fn().mockResolvedValue(undefined),
		getAllWorldsForOwner: vi.fn().mockResolvedValue([]),
		getRoom: vi.fn().mockResolvedValue(null),
		updateRooms: vi.fn().mockResolvedValue(undefined),
		addParticipant: vi.fn().mockResolvedValue(true),
		getRoomsByWorld: vi.fn().mockResolvedValue([]),
		ensureEmbeddingDimension: vi.fn().mockResolvedValue(1536),
		getCaches: vi.fn().mockResolvedValue(new Map()),
		setCaches: vi.fn().mockResolvedValue(true),
		deleteCaches: vi.fn().mockResolvedValue(true),
		getComponent: vi.fn().mockResolvedValue(null),
		getComponents: vi.fn().mockResolvedValue([]),
		getComponentsByIds: vi.fn().mockResolvedValue([]),
		createComponents: vi.fn().mockResolvedValue(true),
		updateComponents: vi.fn().mockResolvedValue(undefined),
		deleteComponents: vi.fn().mockResolvedValue(undefined),
		getLogs: vi.fn().mockResolvedValue([]),
		deleteLogs: vi.fn().mockResolvedValue(undefined),
		getAgentsByIds: vi.fn().mockResolvedValue([]),
		createAgents: vi.fn().mockResolvedValue(true),
		updateAgents: vi.fn().mockResolvedValue(undefined),
		deleteAgents: vi.fn().mockResolvedValue(undefined),
		countLogs: vi.fn().mockResolvedValue(0),
		deleteLogsByRunId: vi.fn().mockResolvedValue(undefined),
		getLogsByRunId: vi.fn().mockResolvedValue([]),
		getAgentsByOwnerId: vi.fn().mockResolvedValue([]),
		listAgents: vi.fn().mockResolvedValue([]),
		createRun: vi.fn().mockResolvedValue(true),
		getRun: vi.fn().mockResolvedValue(null),
		updateRun: vi.fn().mockResolvedValue(undefined),
		getRunsByAgentId: vi.fn().mockResolvedValue([]),
		deleteRun: vi.fn().mockResolvedValue(undefined),
		getAgentRuns: vi.fn().mockResolvedValue([]),
		getCurrentRunSummary: vi.fn().mockResolvedValue(null),
		getAgentRunSummaries: vi
			.fn()
			.mockResolvedValue({ runs: [], totalCount: 0 }),
		getAgentById: vi.fn().mockResolvedValue(null),
		setSettingsByAgentId: vi.fn().mockResolvedValue(undefined),
		getSettingsByAgentId: vi.fn().mockResolvedValue(null),
		deleteSettingsByAgentId: vi.fn().mockResolvedValue(undefined),
		getTasks: vi.fn().mockResolvedValue([]),
		getTasksByIds: vi.fn().mockResolvedValue([]),
		createTasks: vi.fn().mockResolvedValue([]),
		updateTasks: vi.fn().mockResolvedValue(undefined),
		deleteTasks: vi.fn().mockResolvedValue(undefined),
		getPairingRequests: vi.fn().mockResolvedValue([]),
		getPairingAllowlist: vi.fn().mockResolvedValue([]),
		createPairingRequests: vi.fn().mockResolvedValue([]),
		updatePairingRequests: vi.fn().mockResolvedValue(undefined),
		deletePairingRequests: vi.fn().mockResolvedValue(undefined),
		createPairingAllowlistEntries: vi.fn().mockResolvedValue([]),
		deletePairingAllowlistEntries: vi.fn().mockResolvedValue(undefined),
		deleteRelationships: vi.fn().mockResolvedValue(undefined),
	}) as IDatabaseAdapter;

// Basic character for testing
const createTestCharacter = (): Character => ({
	name: "TestAgent",
	username: "test_agent",
	templates: {},
	bio: ["A test agent for action planning tests."],
	messageExamples: [],
	postExamples: [],
	topics: [],
	adjectives: [],
	knowledge: [],
	plugins: [],
	secrets: {},
	settings: {},
});

describe("ACTION_PLANNING Feature", () => {
	let mockDatabaseAdapter: IDatabaseAdapter;

	beforeEach(() => {
		adapterReady = false;
		mockDatabaseAdapter = createMockDatabaseAdapter();
	});

	describe("isActionPlanningEnabled()", () => {
		it("should return true by default when no option is set", () => {
			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
			});

			expect(runtime.isActionPlanningEnabled()).toBe(true);
		});

		it("should return false when actionPlanning constructor option is false", () => {
			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				actionPlanning: false,
			});

			expect(runtime.isActionPlanningEnabled()).toBe(false);
		});

		it("should return true when actionPlanning constructor option is true", () => {
			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				actionPlanning: true,
			});

			expect(runtime.isActionPlanningEnabled()).toBe(true);
		});

		it("should prioritize constructor option over settings", () => {
			const character = createTestCharacter();
			character.settings = { ACTION_PLANNING: "false" };

			const runtime = new AgentRuntime({
				character,
				adapter: mockDatabaseAdapter,
				actionPlanning: true, // Constructor should win
			});

			expect(runtime.isActionPlanningEnabled()).toBe(true);
		});

		it("should use ACTION_PLANNING setting when no constructor option", () => {
			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				settings: { ACTION_PLANNING: "false" },
			});

			expect(runtime.isActionPlanningEnabled()).toBe(false);
		});

		it("should handle boolean ACTION_PLANNING setting", () => {
			// Testing with boolean value (intentional type test)
			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				settings: { ACTION_PLANNING: false as string },
			});

			expect(runtime.isActionPlanningEnabled()).toBe(false);
		});

		it("should handle string 'true' ACTION_PLANNING setting", () => {
			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				settings: { ACTION_PLANNING: "true" },
			});

			expect(runtime.isActionPlanningEnabled()).toBe(true);
		});

		it("should handle string 'TRUE' (case-insensitive) ACTION_PLANNING setting", () => {
			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				settings: { ACTION_PLANNING: "TRUE" },
			});

			expect(runtime.isActionPlanningEnabled()).toBe(true);
		});
	});

	describe("processActions() with action planning disabled", () => {
		it("should process only one action when actionPlanning is false", async () => {
			const processedActions: string[] = [];

			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				actionPlanning: false,
			});

			// Register mock actions
			runtime.registerAction({
				name: "ACTION_ONE",
				description: "First test action",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					processedActions.push("ACTION_ONE");
				},
			});

			runtime.registerAction({
				name: "ACTION_TWO",
				description: "Second test action",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					processedActions.push("ACTION_TWO");
				},
			});

			// Create a message with multiple actions
			const message: Memory = {
				id: stringToUuid(uuidv4()),
				entityId: stringToUuid(uuidv4()),
				roomId: stringToUuid(uuidv4()),
				content: {
					text: "Test message",
					actions: ["ACTION_ONE", "ACTION_TWO"],
				},
				type: MemoryType.MESSAGE,
				createdAt: Date.now(),
			};

			// Create responses with multiple actions
			const responses: Memory[] = [
				{
					id: stringToUuid(uuidv4()),
					entityId: stringToUuid(uuidv4()),
					roomId: stringToUuid(uuidv4()),
					content: {
						text: "Response",
						actions: ["ACTION_ONE", "ACTION_TWO"],
					},
					type: MemoryType.MESSAGE,
					createdAt: Date.now(),
				},
			];

			await runtime.processActions(message, responses);

			// Only one action should be processed
			expect(processedActions).toHaveLength(1);
			expect(processedActions[0]).toBe("ACTION_ONE");
		});

		it("should process all actions when actionPlanning is true", async () => {
			const processedActions: string[] = [];

			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				actionPlanning: true,
			});

			// Register mock actions
			runtime.registerAction({
				name: "ACTION_ONE",
				description: "First test action",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					processedActions.push("ACTION_ONE");
				},
			});

			runtime.registerAction({
				name: "ACTION_TWO",
				description: "Second test action",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					processedActions.push("ACTION_TWO");
				},
			});

			// Create a message with multiple actions
			const message: Memory = {
				id: stringToUuid(uuidv4()),
				entityId: stringToUuid(uuidv4()),
				roomId: stringToUuid(uuidv4()),
				content: {
					text: "Test message",
					actions: ["ACTION_ONE", "ACTION_TWO"],
				},
				type: MemoryType.MESSAGE,
				createdAt: Date.now(),
			};

			// Create responses with multiple actions
			const responses: Memory[] = [
				{
					id: stringToUuid(uuidv4()),
					entityId: stringToUuid(uuidv4()),
					roomId: stringToUuid(uuidv4()),
					content: {
						text: "Response",
						actions: ["ACTION_ONE", "ACTION_TWO"],
					},
					type: MemoryType.MESSAGE,
					createdAt: Date.now(),
				},
			];

			await runtime.processActions(message, responses);

			// All actions should be processed
			expect(processedActions).toHaveLength(2);
			expect(processedActions).toContain("ACTION_ONE");
			expect(processedActions).toContain("ACTION_TWO");
		});

		it("should handle single action in response when actionPlanning is false", async () => {
			const processedActions: string[] = [];

			const runtime = new AgentRuntime({
				character: createTestCharacter(),
				adapter: mockDatabaseAdapter,
				actionPlanning: false,
			});

			runtime.registerAction({
				name: "SINGLE_ACTION",
				description: "Single test action",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					processedActions.push("SINGLE_ACTION");
				},
			});

			const message: Memory = {
				id: stringToUuid(uuidv4()),
				entityId: stringToUuid(uuidv4()),
				roomId: stringToUuid(uuidv4()),
				content: {
					text: "Test message",
					actions: ["SINGLE_ACTION"],
				},
				type: MemoryType.MESSAGE,
				createdAt: Date.now(),
			};

			const responses: Memory[] = [
				{
					id: stringToUuid(uuidv4()),
					entityId: stringToUuid(uuidv4()),
					roomId: stringToUuid(uuidv4()),
					content: {
						text: "Response",
						actions: ["SINGLE_ACTION"],
					},
					type: MemoryType.MESSAGE,
					createdAt: Date.now(),
				},
			];

			await runtime.processActions(message, responses);

			expect(processedActions).toHaveLength(1);
			expect(processedActions[0]).toBe("SINGLE_ACTION");
		});
	});

	describe("Game scenario - single action per turn", () => {
		it("should only execute one game action per turn with actionPlanning disabled", async () => {
			const executedMoves: string[] = [];

			const runtime = new AgentRuntime({
				character: {
					...createTestCharacter(),
					name: "GamePlayer",
				},
				adapter: mockDatabaseAdapter,
				actionPlanning: false, // Game mode - single action only
			});

			// Register game actions
			runtime.registerAction({
				name: "MOVE_NORTH",
				description: "Move north",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					executedMoves.push("NORTH");
				},
			});

			runtime.registerAction({
				name: "ATTACK",
				description: "Attack enemy",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					executedMoves.push("ATTACK");
				},
			});

			runtime.registerAction({
				name: "PICKUP",
				description: "Pick up item",
				similes: [],
				examples: [],
				validate: async () => true,
				handler: async () => {
					executedMoves.push("PICKUP");
				},
			});

			// Agent tries to do multiple actions at once
			const message: Memory = {
				id: stringToUuid(uuidv4()),
				entityId: stringToUuid(uuidv4()),
				roomId: stringToUuid(uuidv4()),
				content: {
					text: "Game turn",
					actions: ["MOVE_NORTH", "ATTACK", "PICKUP"],
				},
				type: MemoryType.MESSAGE,
				createdAt: Date.now(),
			};

			const responses: Memory[] = [
				{
					id: stringToUuid(uuidv4()),
					entityId: stringToUuid(uuidv4()),
					roomId: stringToUuid(uuidv4()),
					content: {
						text: "Turn actions",
						actions: ["MOVE_NORTH", "ATTACK", "PICKUP"],
					},
					type: MemoryType.MESSAGE,
					createdAt: Date.now(),
				},
			];

			await runtime.processActions(message, responses);

			// Only first action should execute (game state changes between actions)
			expect(executedMoves).toHaveLength(1);
			expect(executedMoves[0]).toBe("NORTH");
		});
	});
});
