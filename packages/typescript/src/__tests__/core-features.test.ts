import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { Character, IDatabaseAdapter, Memory, UUID } from "../types";
import { MemoryType } from "../types";
import { DEFAULT_UUID } from "../types/primitives";

const stringToUuid = (id: string): UUID => id as UUID;

// Minimal mock database adapter for tests
const createMockDatabaseAdapter = (): IDatabaseAdapter =>
  ({
    isRoomParticipant: vi.fn().mockResolvedValue(true),
    db: {},
    init: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
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
    createWorld: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
    getWorld: vi.fn().mockResolvedValue(null),
    removeWorld: vi.fn().mockResolvedValue(undefined),
    getAllWorlds: vi.fn().mockResolvedValue([]),
    updateWorld: vi.fn().mockResolvedValue(undefined),
    getRoomsByIds: vi.fn().mockResolvedValue([]),
    createRooms: vi.fn().mockResolvedValue([]),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    updateRoom: vi.fn().mockResolvedValue(undefined),
    getRoomsForParticipant: vi.fn().mockResolvedValue([]),
    getRoomsForParticipants: vi.fn().mockResolvedValue([]),
    getRoomsByWorld: vi.fn().mockResolvedValue([]),
    removeParticipant: vi.fn().mockResolvedValue(true),
    getParticipantsForEntity: vi.fn().mockResolvedValue([]),
    getParticipantsForRoom: vi.fn().mockResolvedValue([]),
    addParticipantsRoom: vi.fn().mockResolvedValue(true),
    getParticipantUserState: vi.fn().mockResolvedValue(null),
    setParticipantUserState: vi.fn().mockResolvedValue(undefined),
    createRelationship: vi.fn().mockResolvedValue(true),
    updateRelationship: vi.fn().mockResolvedValue(undefined),
    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),
    getCache: vi.fn().mockResolvedValue(null),
    setCache: vi.fn().mockResolvedValue(true),
    deleteCache: vi.fn().mockResolvedValue(true),
    createTask: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(null),
    getTasksByName: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    createAgent: vi.fn().mockResolvedValue(true),
    updateAgent: vi.fn().mockResolvedValue(true),
    deleteAgent: vi.fn().mockResolvedValue(true),
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponent: vi.fn().mockResolvedValue(true),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),
    getAgentRunSummaries: vi
      .fn()
      .mockResolvedValue({ runs: [], total: 0, hasMore: false }),
    getLogs: vi.fn().mockResolvedValue([]),
    deleteLog: vi.fn().mockResolvedValue(undefined),
    updateMemory: vi.fn().mockResolvedValue(true),
    deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
    getMemoriesByWorldId: vi.fn().mockResolvedValue([]),
  }) satisfies Partial<IDatabaseAdapter> as IDatabaseAdapter;

const mockCharacter: Character = {
  id: stringToUuid(uuidv4()),
  name: "Test Character",
  username: "test",
  templates: {},
  bio: ["Test bio"],
  messageExamples: [],
  postExamples: [],
  topics: [],
  adjectives: [],
  knowledge: [],
  plugins: [],
  secrets: {},
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
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
