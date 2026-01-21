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
    getMemoryById: vi.fn().mockResolvedValue(null),
    getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
    getMemoriesByIds: vi.fn().mockResolvedValue([]),
    getCachedEmbeddings: vi.fn().mockResolvedValue([]),
    log: vi.fn().mockResolvedValue(undefined),
    searchMemories: vi.fn().mockResolvedValue([]),
    createMemory: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteManyMemories: vi.fn().mockResolvedValue(undefined),
    deleteAllMemories: vi.fn().mockResolvedValue(undefined),
    countMemories: vi.fn().mockResolvedValue(0),
    getRoomsByIds: vi.fn().mockResolvedValue([]),
    createRooms: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    getRoomsForParticipant: vi.fn().mockResolvedValue([]),
    getRoomsForParticipants: vi.fn().mockResolvedValue([]),
    addParticipantsRoom: vi.fn().mockResolvedValue(true),
    removeParticipant: vi.fn().mockResolvedValue(true),
    getParticipantsForEntity: vi.fn().mockResolvedValue([]),
    getParticipantsForRoom: vi.fn().mockResolvedValue([]),
    getParticipantUserState: vi.fn().mockResolvedValue(null),
    setParticipantUserState: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(true),
    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),
    getEntityById: vi.fn().mockResolvedValue(null),
    createEntity: vi.fn().mockResolvedValue(true),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    deleteEntity: vi.fn().mockResolvedValue(undefined),
    createWorld: vi.fn().mockResolvedValue(true),
    getWorld: vi.fn().mockResolvedValue(null),
    getWorlds: vi.fn().mockResolvedValue([]),
    updateWorld: vi.fn().mockResolvedValue(undefined),
    deleteWorld: vi.fn().mockResolvedValue(undefined),
    getAllWorldsForOwner: vi.fn().mockResolvedValue([]),
    getRoom: vi.fn().mockResolvedValue(null),
    createRoom: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
    updateRoom: vi.fn().mockResolvedValue(undefined),
    addParticipant: vi.fn().mockResolvedValue(true),
    getRoomsByWorld: vi.fn().mockResolvedValue([]),
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(1536),
    getCache: vi.fn().mockResolvedValue(null),
    setCache: vi.fn().mockResolvedValue(true),
    deleteCache: vi.fn().mockResolvedValue(true),
    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponent: vi.fn().mockResolvedValue(true),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue([]),
    getAgent: vi.fn().mockResolvedValue(null),
    createAgent: vi.fn().mockResolvedValue(true),
    updateAgent: vi.fn().mockResolvedValue(undefined),
    deleteAgent: vi.fn().mockResolvedValue(undefined),
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
    getAgentById: vi.fn().mockResolvedValue(null),
    setSettingsByAgentId: vi.fn().mockResolvedValue(undefined),
    getSettingsByAgentId: vi.fn().mockResolvedValue(null),
    deleteSettingsByAgentId: vi.fn().mockResolvedValue(undefined),
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(null),
    createTask: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
  }) as IDatabaseAdapter;

const createTestCharacter = (): Character => ({
  name: "TestAgent",
  username: "test_agent",
  templates: {},
  bio: ["A test agent for action parameter tests."],
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: [],
  secrets: {},
  settings: {},
});

describe("Action parameters (optional)", () => {
  let mockDatabaseAdapter: IDatabaseAdapter;

  beforeEach(() => {
    adapterReady = false;
    mockDatabaseAdapter = createMockDatabaseAdapter();
  });

  it("passes validated parameters from <params> to action.handler via HandlerOptions.parameters", async () => {
    const receivedDirections: string[] = [];

    const runtime = new AgentRuntime({
      character: createTestCharacter(),
      adapter: mockDatabaseAdapter,
      actionPlanning: false,
    });

    runtime.registerAction({
      name: "MOVE",
      description: "Move the agent by one cell.",
      similes: [],
      examples: [],
      parameters: [
        {
          name: "direction",
          description: "Direction to move (north or south).",
          required: false,
          schema: {
            type: "string",
            enum: ["north", "south"],
            default: "north",
          },
        },
      ],
      validate: async () => true,
      handler: async (_runtime, _message, _state, options) => {
        const dirValue = options?.parameters?.direction;
        receivedDirections.push(typeof dirValue === "string" ? dirValue : "");
        return {
          success: true,
          data: { actionName: "MOVE" },
        };
      },
    });

    const message: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: stringToUuid(uuidv4()),
      roomId: stringToUuid(uuidv4()),
      content: { text: "tick" },
      type: MemoryType.MESSAGE,
      createdAt: Date.now(),
    };

    const responses: Memory[] = [
      {
        id: stringToUuid(uuidv4()),
        entityId: stringToUuid(uuidv4()),
        roomId: message.roomId,
        content: {
          text: "move",
          actions: ["MOVE"],
          // `parseKeyValueXml` strips the outer <params> wrapper and stores the inner XML string
          params: "<MOVE><direction>south</direction></MOVE>",
        },
        type: MemoryType.MESSAGE,
        createdAt: Date.now(),
      },
    ];

    await runtime.processActions(message, responses);

    expect(receivedDirections).toEqual(["south"]);
  });

  it("applies default values when <params> omits an optional parameter with a default", async () => {
    const receivedDirections: string[] = [];

    const runtime = new AgentRuntime({
      character: createTestCharacter(),
      adapter: mockDatabaseAdapter,
      actionPlanning: false,
    });

    runtime.registerAction({
      name: "MOVE",
      description: "Move the agent by one cell.",
      similes: [],
      examples: [],
      parameters: [
        {
          name: "direction",
          description: "Direction to move (north or south).",
          required: false,
          schema: {
            type: "string",
            enum: ["north", "south"],
            default: "north",
          },
        },
      ],
      validate: async () => true,
      handler: async (_runtime, _message, _state, options) => {
        const dirValue = options?.parameters?.direction;
        receivedDirections.push(typeof dirValue === "string" ? dirValue : "");
        return {
          success: true,
          data: { actionName: "MOVE" },
        };
      },
    });

    const message: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: stringToUuid(uuidv4()),
      roomId: stringToUuid(uuidv4()),
      content: { text: "tick" },
      type: MemoryType.MESSAGE,
      createdAt: Date.now(),
    };

    const responses: Memory[] = [
      {
        id: stringToUuid(uuidv4()),
        entityId: stringToUuid(uuidv4()),
        roomId: message.roomId,
        content: {
          text: "move",
          actions: ["MOVE"],
          // <params> omitted entirely
        },
        type: MemoryType.MESSAGE,
        createdAt: Date.now(),
      },
    ];

    await runtime.processActions(message, responses);

    expect(receivedDirections).toEqual(["north"]);
  });

  it("skips action execution when required parameters are missing", async () => {
    let executed = false;
    let receivedErrors: string[] = [];

    const runtime = new AgentRuntime({
      character: createTestCharacter(),
      adapter: mockDatabaseAdapter,
      actionPlanning: false,
    });

    runtime.registerAction({
      name: "MOVE",
      description: "Move the agent by one cell.",
      similes: [],
      examples: [],
      parameters: [
        {
          name: "direction",
          description: "Direction to move (required).",
          required: true,
          schema: { type: "string", enum: ["north", "south"] },
        },
      ],
      validate: async () => true,
      handler: async (_runtime, _message, _state, options) => {
        executed = true;
        receivedErrors = options?.parameterErrors ?? [];
        return {
          success: true,
          data: { actionName: "MOVE" },
        };
      },
    });

    const message: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: stringToUuid(uuidv4()),
      roomId: stringToUuid(uuidv4()),
      content: { text: "tick" },
      type: MemoryType.MESSAGE,
      createdAt: Date.now(),
    };

    const responses: Memory[] = [
      {
        id: stringToUuid(uuidv4()),
        entityId: stringToUuid(uuidv4()),
        roomId: message.roomId,
        content: {
          text: "move",
          actions: ["MOVE"],
          // Missing required direction
        },
        type: MemoryType.MESSAGE,
        createdAt: Date.now(),
      },
    ];

    await runtime.processActions(message, responses);

    expect(executed).toBe(true);
    expect(receivedErrors.join("\n")).toContain(
      "Required parameter 'direction'",
    );
  });
});
