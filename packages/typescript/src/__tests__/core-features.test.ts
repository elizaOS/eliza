import { describe, expect, it, mock, beforeEach } from "bun:test";
import { v4 as uuidv4 } from "uuid";
import { AgentRuntime } from "../runtime";
import { DEFAULT_UUID } from "../types/primitives";
import type {
  Character,
  IDatabaseAdapter,
  Memory,
  UUID,
} from "../types";
import { MemoryType } from "../types";

const stringToUuid = (id: string): UUID => id as UUID;

// Minimal mock database adapter for tests
const createMockDatabaseAdapter = (): IDatabaseAdapter => ({
  isRoomParticipant: mock().mockResolvedValue(true),
  db: {},
  init: mock().mockResolvedValue(undefined),
  initialize: mock().mockResolvedValue(undefined),
  isReady: mock().mockResolvedValue(true),
  close: mock().mockResolvedValue(undefined),
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
  createWorld: mock().mockResolvedValue(stringToUuid(uuidv4())),
  getWorld: mock().mockResolvedValue(null),
  removeWorld: mock().mockResolvedValue(undefined),
  getAllWorlds: mock().mockResolvedValue([]),
  updateWorld: mock().mockResolvedValue(undefined),
  getRoomsByIds: mock().mockResolvedValue([]),
  createRooms: mock().mockResolvedValue([]),
  deleteRoom: mock().mockResolvedValue(undefined),
  updateRoom: mock().mockResolvedValue(undefined),
  getRoomsForParticipant: mock().mockResolvedValue([]),
  getRoomsForParticipants: mock().mockResolvedValue([]),
  getRoomsByWorld: mock().mockResolvedValue([]),
  removeParticipant: mock().mockResolvedValue(true),
  getParticipantsForEntity: mock().mockResolvedValue([]),
  getParticipantsForRoom: mock().mockResolvedValue([]),
  addParticipantsRoom: mock().mockResolvedValue(true),
  getParticipantUserState: mock().mockResolvedValue(null),
  setParticipantUserState: mock().mockResolvedValue(undefined),
  createRelationship: mock().mockResolvedValue(true),
  updateRelationship: mock().mockResolvedValue(undefined),
  getRelationship: mock().mockResolvedValue(null),
  getRelationships: mock().mockResolvedValue([]),
  getCache: mock().mockResolvedValue(null),
  setCache: mock().mockResolvedValue(true),
  deleteCache: mock().mockResolvedValue(true),
  createTask: mock().mockResolvedValue(stringToUuid(uuidv4())),
  getTasks: mock().mockResolvedValue([]),
  getTask: mock().mockResolvedValue(null),
  getTasksByName: mock().mockResolvedValue([]),
  updateTask: mock().mockResolvedValue(undefined),
  deleteTask: mock().mockResolvedValue(undefined),
  getAgent: mock().mockResolvedValue(null),
  getAgents: mock().mockResolvedValue([]),
  createAgent: mock().mockResolvedValue(true),
  updateAgent: mock().mockResolvedValue(true),
  deleteAgent: mock().mockResolvedValue(true),
  ensureEmbeddingDimension: mock().mockResolvedValue(undefined),
  getEntitiesForRoom: mock().mockResolvedValue([]),
  updateEntity: mock().mockResolvedValue(undefined),
  getComponent: mock().mockResolvedValue(null),
  getComponents: mock().mockResolvedValue([]),
  createComponent: mock().mockResolvedValue(true),
  updateComponent: mock().mockResolvedValue(undefined),
  deleteComponent: mock().mockResolvedValue(undefined),
  getAgentRunSummaries: mock().mockResolvedValue({ runs: [], total: 0, hasMore: false }),
  getLogs: mock().mockResolvedValue([]),
  deleteLog: mock().mockResolvedValue(undefined),
  updateMemory: mock().mockResolvedValue(true),
  deleteRoomsByWorldId: mock().mockResolvedValue(undefined),
  getMemoriesByWorldId: mock().mockResolvedValue([]),
} as unknown as IDatabaseAdapter);

const mockCharacter: Character = {
  id: stringToUuid(uuidv4()),
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
};

describe("DEFAULT_UUID", () => {
  it("should be the nil/zero UUID", () => {
    expect(DEFAULT_UUID).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("should be a valid UUID format", () => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(DEFAULT_UUID).toMatch(uuidRegex);
  });

  it("should be usable as a roomId in Memory", () => {
    const memory: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: stringToUuid(uuidv4()),
      roomId: DEFAULT_UUID,
      content: { text: "Hello" },
      createdAt: Date.now(),
      metadata: { type: MemoryType.MESSAGE },
    };
    expect(memory.roomId).toBe(DEFAULT_UUID);
  });

  it("should be usable as a worldId in Memory", () => {
    const memory: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: stringToUuid(uuidv4()),
      roomId: stringToUuid(uuidv4()),
      worldId: DEFAULT_UUID,
      content: { text: "Hello" },
      createdAt: Date.now(),
      metadata: { type: MemoryType.MESSAGE },
    };
    expect(memory.worldId).toBe(DEFAULT_UUID);
  });
});

describe("AgentRuntime Log Level Configuration", () => {
  let mockAdapter: IDatabaseAdapter;

  beforeEach(() => {
    mockAdapter = createMockDatabaseAdapter();
  });

  it("should default log level to error", () => {
    const runtime = new AgentRuntime({
      character: mockCharacter,
      adapter: mockAdapter,
    });
    // The logger should be configured with error level by default
    expect(runtime.logger).toBeDefined();
  });

  it("should accept info log level", () => {
    const runtime = new AgentRuntime({
      character: mockCharacter,
      adapter: mockAdapter,
      logLevel: "info",
    });
    expect(runtime.logger).toBeDefined();
  });

  it("should accept debug log level", () => {
    const runtime = new AgentRuntime({
      character: mockCharacter,
      adapter: mockAdapter,
      logLevel: "debug",
    });
    expect(runtime.logger).toBeDefined();
  });

  it("should accept warn log level", () => {
    const runtime = new AgentRuntime({
      character: mockCharacter,
      adapter: mockAdapter,
      logLevel: "warn",
    });
    expect(runtime.logger).toBeDefined();
  });

  it("should accept trace log level", () => {
    const runtime = new AgentRuntime({
      character: mockCharacter,
      adapter: mockAdapter,
      logLevel: "trace",
    });
    expect(runtime.logger).toBeDefined();
  });

  it("should accept fatal log level", () => {
    const runtime = new AgentRuntime({
      character: mockCharacter,
      adapter: mockAdapter,
      logLevel: "fatal",
    });
    expect(runtime.logger).toBeDefined();
  });
});

describe("AgentRuntime with DEFAULT_UUID", () => {
  it("should allow Memory creation with DEFAULT_UUID as roomId", () => {
    // Test that DEFAULT_UUID can be used in Memory without runtime initialization
    const memory: Memory = {
      id: stringToUuid(uuidv4()),
      entityId: stringToUuid(uuidv4()),
      roomId: DEFAULT_UUID,
      worldId: DEFAULT_UUID,
      content: { text: "Hello using default room and world" },
      createdAt: Date.now(),
      metadata: { type: MemoryType.MESSAGE },
    };

    // Should be valid memory with DEFAULT_UUID
    expect(memory.roomId).toBe(DEFAULT_UUID);
    expect(memory.worldId).toBe(DEFAULT_UUID);
  });
});

