import { beforeEach, describe, expect, it, mock } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import { AgentRuntime } from "../runtime";
import type {
  Character,
  IDatabaseAdapter,
  Memory,
  UUID,
} from "../types";
import { MemoryType } from "../types";

const stringToUuid = (id: string): UUID => id as UUID;

// Track adapter readiness across init/close
let adapterReady = false;

// Mock IDatabaseAdapter (minimal for these tests)
const createMockDatabaseAdapter = (): IDatabaseAdapter =>
  ({
    isRoomParticipant: mock().mockResolvedValue(true),
    db: {},
    init: mock().mockImplementation(async () => {
      adapterReady = true;
    }),
    initialize: mock().mockResolvedValue(undefined),
    isReady: mock().mockImplementation(async () => adapterReady),
    close: mock().mockImplementation(async () => {
      adapterReady = false;
    }),
    getConnection: mock().mockResolvedValue({}),
    getEntitiesByIds: mock().mockResolvedValue([]),
    createEntities: mock().mockResolvedValue(true),
    getMemories: mock().mockResolvedValue([]),
    getMemoryById: mock().mockResolvedValue(null),
    getMemoriesByRoomIds: mock().mockResolvedValue([]),
    getMemoriesByIds: mock().mockResolvedValue([]),
    getCachedEmbeddings: mock().mockResolvedValue([]),
    log: mock().mockResolvedValue(undefined),
    searchMemories: mock().mockResolvedValue([]),
    createMemory: mock().mockResolvedValue(stringToUuid(uuidv4())),
    deleteMemory: mock().mockResolvedValue(undefined),
    deleteManyMemories: mock().mockResolvedValue(undefined),
    deleteAllMemories: mock().mockResolvedValue(undefined),
    countMemories: mock().mockResolvedValue(0),
    getRoomsByIds: mock().mockResolvedValue([]),
    createRooms: mock().mockResolvedValue([stringToUuid(uuidv4())]),
    deleteRoom: mock().mockResolvedValue(undefined),
    getRoomsForParticipant: mock().mockResolvedValue([]),
    getRoomsForParticipants: mock().mockResolvedValue([]),
    addParticipantsRoom: mock().mockResolvedValue(true),
    removeParticipant: mock().mockResolvedValue(true),
    getParticipantsForEntity: mock().mockResolvedValue([]),
    getParticipantsForRoom: mock().mockResolvedValue([]),
    getParticipantUserState: mock().mockResolvedValue(null),
    setParticipantUserState: mock().mockResolvedValue(undefined),
    createRelationship: mock().mockResolvedValue(true),
    getRelationship: mock().mockResolvedValue(null),
    getRelationships: mock().mockResolvedValue([]),
    getEntityById: mock().mockResolvedValue(null),
    createEntity: mock().mockResolvedValue(true),
    updateEntity: mock().mockResolvedValue(undefined),
    deleteEntity: mock().mockResolvedValue(undefined),
    createWorld: mock().mockResolvedValue(true),
    getWorld: mock().mockResolvedValue(null),
    getWorlds: mock().mockResolvedValue([]),
    updateWorld: mock().mockResolvedValue(undefined),
    deleteWorld: mock().mockResolvedValue(undefined),
    getAllWorldsForOwner: mock().mockResolvedValue([]),
    getRoom: mock().mockResolvedValue(null),
    createRoom: mock().mockResolvedValue(stringToUuid(uuidv4())),
    updateRoom: mock().mockResolvedValue(undefined),
    addParticipant: mock().mockResolvedValue(true),
    getRoomsByWorld: mock().mockResolvedValue([]),
    ensureEmbeddingDimension: mock().mockResolvedValue(1536),
    getCache: mock().mockResolvedValue(null),
    setCache: mock().mockResolvedValue(true),
    deleteCache: mock().mockResolvedValue(true),
    getComponent: mock().mockResolvedValue(null),
    getComponents: mock().mockResolvedValue([]),
    createComponent: mock().mockResolvedValue(true),
    updateComponent: mock().mockResolvedValue(undefined),
    deleteComponent: mock().mockResolvedValue(undefined),
    getLogs: mock().mockResolvedValue([]),
    getAgent: mock().mockResolvedValue(null),
    createAgent: mock().mockResolvedValue(true),
    updateAgent: mock().mockResolvedValue(undefined),
    deleteAgent: mock().mockResolvedValue(undefined),
    countLogs: mock().mockResolvedValue(0),
    deleteLogsByRunId: mock().mockResolvedValue(undefined),
    getLogsByRunId: mock().mockResolvedValue([]),
    getAgentsByOwnerId: mock().mockResolvedValue([]),
    listAgents: mock().mockResolvedValue([]),
    createRun: mock().mockResolvedValue(true),
    getRun: mock().mockResolvedValue(null),
    updateRun: mock().mockResolvedValue(undefined),
    getRunsByAgentId: mock().mockResolvedValue([]),
    deleteRun: mock().mockResolvedValue(undefined),
    getAgentRuns: mock().mockResolvedValue([]),
    getCurrentRunSummary: mock().mockResolvedValue(null),
    getAgentById: mock().mockResolvedValue(null),
    setSettingsByAgentId: mock().mockResolvedValue(undefined),
    getSettingsByAgentId: mock().mockResolvedValue(null),
    deleteSettingsByAgentId: mock().mockResolvedValue(undefined),
    getTasks: mock().mockResolvedValue([]),
    getTask: mock().mockResolvedValue(null),
    createTask: mock().mockResolvedValue(stringToUuid(uuidv4())),
    updateTask: mock().mockResolvedValue(undefined),
    deleteTask: mock().mockResolvedValue(undefined),
  }) as IDatabaseAdapter;

// Basic character for testing
const createTestCharacter = (): Character => ({
  name: "TestAgent",
  username: "test_agent",
  bio: ["A test agent for action planning tests."],
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
      const runtime = new AgentRuntime({
        character: createTestCharacter(),
        adapter: mockDatabaseAdapter,
        settings: { ACTION_PLANNING: false as unknown as string },
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


