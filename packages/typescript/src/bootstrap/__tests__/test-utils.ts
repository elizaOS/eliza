// TODO: Try-catch review completed 2026-01-11. All try-catch blocks retained:
// - cleanupTestRuntime: Ignore runtime.stop() errors - KEEP (test cleanup robustness)

/**
 * @fileoverview Test Utilities for Bootstrap Plugin Tests
 *
 * Provides utilities for creating AgentRuntime instances for testing.
 * Uses IAgentRuntime interface throughout - MockRuntime is an alias for IAgentRuntime.
 */

import { v4 as uuidv4 } from "uuid";
import { vi } from "vitest";
import type { Logger } from "../../logger";
import { AgentRuntime } from "../../runtime";
import type {
  Character,
  Content,
  Entity,
  IAgentRuntime,
  IDatabaseAdapter,
  Memory,
  MemoryMetadata,
  Plugin,
  Room,
  State,
  Task,
  UUID,
  World,
} from "../../types";
import { ChannelType, MemoryType, ModelType } from "../../types";

/**
 * Converts a string to a UUID type
 */
export function stringToUuid(str: string): UUID {
  return str as UUID;
}

/**
 * Creates a UUID for testing
 */
export function createUUID(): UUID {
  return stringToUuid(uuidv4());
}

/**
 * Default test character configuration
 */
export const DEFAULT_TEST_CHARACTER: Character = {
  name: "Test Agent",
  bio: ["A test agent for unit testing"],
  system: "You are a helpful assistant used for testing. Respond concisely.",
  plugins: [],
  settings: {},
  messageExamples: [],
  postExamples: [],
  topics: ["testing"],
  adjectives: ["helpful", "test"],
  style: { all: [], chat: [], post: [] },
};

/**
 * Creates a test character with sensible defaults
 */
export function createTestCharacter(
  overrides: Partial<Character> = {},
): Character {
  return {
    ...DEFAULT_TEST_CHARACTER,
    id: createUUID(),
    ...overrides,
  };
}

/**
 * Type alias for backward compatibility.
 * MockRuntime is just IAgentRuntime - no separate type.
 */
export type MockRuntime = IAgentRuntime;

/**
 * Creates a comprehensive mock database adapter for testing.
 * This adapter uses in-memory maps to simulate database operations.
 */
export function createMockDatabaseAdapter(agentId?: UUID): IDatabaseAdapter {
  const resolvedAgentId = agentId || createUUID();

  // In-memory storage
  const memories = new Map<UUID, Memory>();
  const rooms = new Map<UUID, Room>();
  const worlds = new Map<UUID, World>();
  const entities = new Map<UUID, Entity>();
  const tasks = new Map<UUID, Task>();
  const cache = new Map<string, unknown>();
  const participants = new Map<UUID, Set<UUID>>(); // roomId -> entityIds
  const participantStates = new Map<string, string | null>(); // `${roomId}-${entityId}` -> state

  return {
    db: {},
    init: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({}),
    isReady: vi.fn().mockResolvedValue(true),

    // Agent methods
    getAgent: vi.fn().mockResolvedValue({
      id: resolvedAgentId,
      name: "TestAgent",
    }),
    getAgents: vi.fn().mockResolvedValue([]),
    createAgent: vi.fn().mockResolvedValue(true),
    updateAgent: vi.fn().mockResolvedValue(true),
    deleteAgent: vi.fn().mockResolvedValue(true),
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),

    // Memory methods
    getMemories: vi.fn(
      async (params: { roomId?: UUID; tableName?: string; count?: number }) => {
        const result: Memory[] = [];
        for (const mem of memories.values()) {
          if (!params.roomId || mem.roomId === params.roomId) {
            result.push(mem);
          }
        }
        return result.slice(0, params.count || 100);
      },
    ),
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) || null),
    getMemoriesByIds: vi.fn(
      async (ids: UUID[]) =>
        ids.map((id) => memories.get(id)).filter(Boolean) as Memory[],
    ),
    getMemoriesByRoomIds: vi.fn(async (params: { roomIds: UUID[] }) => {
      const result: Memory[] = [];
      for (const mem of memories.values()) {
        if (params.roomIds.includes(mem.roomId)) {
          result.push(mem);
        }
      }
      return result;
    }),
    getCachedEmbeddings: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    createMemory: vi.fn(async (memory: Memory, _tableName?: string) => {
      const id = memory.id || createUUID();
      memories.set(id, { ...memory, id });
      return id;
    }),
    updateMemory: vi.fn().mockResolvedValue(true),
    deleteMemory: vi.fn(async (id: UUID) => {
      memories.delete(id);
    }),
    deleteManyMemories: vi.fn(async (ids: UUID[]) => {
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
    createEntities: vi.fn(async (newEntities: Entity[]) => {
      for (const entity of newEntities) {
        if (entity.id) {
          entities.set(entity.id, entity);
        }
      }
      return true;
    }),
    updateEntity: vi.fn().mockResolvedValue(undefined),

    // Component methods
    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponent: vi.fn().mockResolvedValue(true),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),

    // Room methods
    getRoomsByIds: vi.fn(
      async (ids: UUID[]) =>
        ids.map((id) => rooms.get(id)).filter(Boolean) as Room[],
    ),
    createRooms: vi.fn(async (newRooms: Room[]) => {
      const ids: UUID[] = [];
      for (const room of newRooms) {
        const id = room.id || createUUID();
        rooms.set(id, { ...room, id });
        participants.set(id, new Set());
        ids.push(id);
      }
      return ids;
    }),
    deleteRoom: vi.fn(async (id: UUID) => {
      rooms.delete(id);
      participants.delete(id);
    }),
    deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
    updateRoom: vi.fn(async (room: Room) => {
      if (room.id) {
        rooms.set(room.id, room);
      }
    }),
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

    // Participant methods
    addParticipantsRoom: vi.fn(async (entityIds: UUID[], roomId: UUID) => {
      let roomParticipants = participants.get(roomId);
      if (!roomParticipants) {
        roomParticipants = new Set();
        participants.set(roomId, roomParticipants);
      }
      for (const id of entityIds) {
        roomParticipants.add(id);
      }
      return true;
    }),
    removeParticipant: vi.fn().mockResolvedValue(true),
    getParticipantsForEntity: vi.fn().mockResolvedValue([]),
    getParticipantsForRoom: vi.fn(async (roomId: UUID) => {
      const roomParticipants = participants.get(roomId);
      return roomParticipants ? Array.from(roomParticipants) : [];
    }),
    isRoomParticipant: vi.fn().mockResolvedValue(false),
    getParticipantUserState: vi.fn(async (roomId: UUID, entityId: UUID) => {
      return participantStates.get(`${roomId}-${entityId}`) || null;
    }),
    setParticipantUserState: vi.fn(
      async (roomId: UUID, entityId: UUID, state: string | null) => {
        participantStates.set(`${roomId}-${entityId}`, state);
      },
    ),

    // World methods
    createWorld: vi.fn(async (world: World) => {
      const id = world.id || createUUID();
      worlds.set(id, { ...world, id });
      return id;
    }),
    getWorld: vi.fn(async (id: UUID) => worlds.get(id) || null),
    removeWorld: vi.fn(async (id: UUID) => {
      worlds.delete(id);
    }),
    getAllWorlds: vi.fn(async () => Array.from(worlds.values())),
    updateWorld: vi.fn(async (world: World) => {
      if (world.id) {
        worlds.set(world.id, world);
      }
    }),

    // Relationship methods
    createRelationship: vi.fn().mockResolvedValue(true),
    updateRelationship: vi.fn().mockResolvedValue(undefined),
    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),

    // Cache methods
    getCache: vi.fn(async <T>(key: string) => cache.get(key) as T | undefined),
    setCache: vi.fn(async <T>(key: string, value: T) => {
      cache.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => {
      cache.delete(key);
      return true;
    }),

    // Task methods
    createTask: vi.fn(async (task: Task) => {
      const id = task.id || createUUID();
      tasks.set(id, { ...task, id });
      return id;
    }),
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(async (id: UUID) => tasks.get(id) || null),
    getTasksByName: vi.fn().mockResolvedValue([]),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn(async (id: UUID) => {
      tasks.delete(id);
    }),

    // Log methods
    log: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue([]),
    deleteLog: vi.fn().mockResolvedValue(undefined),
  } as IDatabaseAdapter;
}

/**
 * Creates a mock IAgentRuntime for unit testing.
 * All methods are mocked with vi.fn() and can be overridden.
 */
export function createMockRuntime(
  overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
  const agentId = (overrides.agentId || "test-agent-id") as UUID;
  const character = overrides.character || createTestCharacter({ id: agentId });

  const mockLogger: Logger = {
    level: "info",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    success: vi.fn(),
    progress: vi.fn(),
    log: vi.fn(),
    clear: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  const baseRuntime: IAgentRuntime = {
    // Core properties
    agentId,
    initPromise: Promise.resolve(),
    character,
    messageService: null,
    providers: overrides.providers || [],
    actions: overrides.actions || [],
    evaluators: overrides.evaluators || [],
    plugins: overrides.plugins || [],
    services: overrides.services || new Map(),
    events: overrides.events || ({} as IAgentRuntime["events"]),
    routes: overrides.routes || [],
    logger: overrides.logger || mockLogger,
    stateCache: overrides.stateCache || new Map(),
    fetch: fetch,

    // Database adapter properties
    db: {},

    // Database methods
    init: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({}),
    isReady: vi.fn().mockResolvedValue(true),

    // Agent methods
    getAgent: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    createAgent: vi.fn().mockResolvedValue(true),
    updateAgent: vi.fn().mockResolvedValue(true),
    deleteAgent: vi.fn().mockResolvedValue(true),

    // Memory methods
    createMemory: vi.fn().mockResolvedValue("memory-id" as UUID),
    getMemories: vi.fn().mockResolvedValue([]),
    getMemoryById: vi.fn().mockResolvedValue(null),
    getMemoriesByIds: vi.fn().mockResolvedValue([]),
    getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),
    updateMemory: vi.fn().mockResolvedValue(true),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteManyMemories: vi.fn().mockResolvedValue(undefined),
    deleteAllMemories: vi.fn().mockResolvedValue(undefined),
    countMemories: vi.fn().mockResolvedValue(0),
    getCachedEmbeddings: vi.fn().mockResolvedValue([]),
    addEmbeddingToMemory: vi.fn().mockResolvedValue({
      id: "memory-id",
      entityId: "test-entity-id",
      roomId: "test-room-id",
      content: { text: "Test fact" },
    }),
    queueEmbeddingGeneration: vi.fn().mockResolvedValue(undefined),
    getMemoriesByWorldId: vi.fn().mockResolvedValue([]),

    // Entity methods
    getEntityById: vi.fn().mockResolvedValue(null),
    getEntitiesByIds: vi.fn().mockResolvedValue([]),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    createEntity: vi.fn().mockResolvedValue(true),
    createEntities: vi.fn().mockResolvedValue(true),
    updateEntity: vi.fn().mockResolvedValue(undefined),

    // Component methods
    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponent: vi.fn().mockResolvedValue(true),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),

    // Room methods
    getRoom: vi.fn().mockResolvedValue({
      id: "test-room-id",
      name: "Test Room",
      worldId: "test-world-id",
      serverId: "test-server-id",
      source: "test",
      type: ChannelType.GROUP,
    }),
    getRooms: vi.fn().mockResolvedValue([]),
    getRoomsByIds: vi.fn().mockResolvedValue([]),
    createRoom: vi.fn().mockResolvedValue("room-id" as UUID),
    createRooms: vi.fn().mockResolvedValue(["room-id" as UUID]),
    updateRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
    getRoomsForParticipant: vi.fn().mockResolvedValue([]),
    getRoomsForParticipants: vi.fn().mockResolvedValue([]),
    getRoomsByWorld: vi.fn().mockResolvedValue([]),
    addParticipant: vi.fn().mockResolvedValue(true),
    addParticipantsRoom: vi.fn().mockResolvedValue(true),
    removeParticipant: vi.fn().mockResolvedValue(true),
    getParticipantsForEntity: vi.fn().mockResolvedValue([]),
    getParticipantsForRoom: vi.fn().mockResolvedValue([]),
    isRoomParticipant: vi.fn().mockResolvedValue(false),
    getParticipantUserState: vi.fn().mockResolvedValue(null),
    setParticipantUserState: vi.fn().mockResolvedValue(undefined),

    // World methods
    getWorld: vi.fn().mockResolvedValue({
      id: "test-world-id",
      name: "Test World",
      serverId: "test-server-id",
      metadata: {
        roles: {
          "test-entity-id": "ADMIN",
          "test-agent-id": "OWNER",
        },
      },
    }),
    createWorld: vi.fn().mockResolvedValue("world-id" as UUID),
    updateWorld: vi.fn().mockResolvedValue(undefined),
    removeWorld: vi.fn().mockResolvedValue(undefined),
    getAllWorlds: vi.fn().mockResolvedValue([]),

    // Relationship methods
    createRelationship: vi.fn().mockResolvedValue(true),
    updateRelationship: vi.fn().mockResolvedValue(undefined),
    getRelationship: vi.fn().mockResolvedValue(null),
    getRelationships: vi.fn().mockResolvedValue([]),

    // Service methods
    getService: vi.fn().mockReturnValue(null),
    getServicesByType: vi.fn().mockReturnValue([]),
    getAllServices: vi.fn().mockReturnValue(new Map()),
    registerService: vi.fn().mockResolvedValue(undefined),
    getRegisteredServiceTypes: vi.fn().mockReturnValue([]),
    hasService: vi.fn().mockReturnValue(false),
    getServiceLoadPromise: vi.fn().mockResolvedValue(null),

    // Plugin methods
    registerPlugin: vi.fn().mockResolvedValue(undefined),
    registerProvider: vi.fn(),
    registerAction: vi.fn(),
    registerEvaluator: vi.fn(),
    registerDatabaseAdapter: vi.fn(),

    // Model methods
    registerModel: vi.fn(),
    getModel: vi.fn().mockReturnValue(undefined),
    useModel: vi.fn().mockImplementation((modelType: string) => {
      if (modelType === ModelType.OBJECT_LARGE) {
        return Promise.resolve({
          thought: "I should respond in a friendly way",
          message: "Hello there! How can I help you today?",
        });
      } else if (modelType === ModelType.TEXT_SMALL) {
        return Promise.resolve("yes");
      } else if (modelType === ModelType.TEXT_LARGE) {
        return Promise.resolve(`<response>
  <thought>Responding to the user greeting.</thought>
  <text>Hello there! How can I help you today?</text>
</response>`);
      } else if (modelType === ModelType.TEXT_EMBEDDING) {
        return Promise.resolve([0.1, 0.2, 0.3, 0.4, 0.5]);
      } else if (modelType === ModelType.IMAGE_DESCRIPTION) {
        return Promise.resolve(`<response>
  <title>Test Image</title>
  <description>A test image description</description>
  <text>This is a test image description generated by the mock runtime.</text>
</response>`);
      } else if (modelType === ModelType.IMAGE) {
        return Promise.resolve({
          imageUrl: "https://example.com/image.png",
        });
      }
      return Promise.resolve({});
    }),

    // Event methods
    registerEvent: vi.fn(),
    getEvent: vi.fn().mockReturnValue(undefined),
    emitEvent: vi.fn().mockResolvedValue(undefined),

    // Settings methods
    setSetting: vi.fn(),
    getSetting: vi.fn().mockReturnValue(null),
    getConversationLength: vi.fn().mockReturnValue(10),

    // Configuration methods
    isActionPlanningEnabled: vi.fn().mockReturnValue(false),
    getLLMMode: vi.fn().mockReturnValue("DEFAULT"),
    isCheckShouldRespondEnabled: vi.fn().mockReturnValue(true),

    // Action processing
    processActions: vi.fn().mockResolvedValue(undefined),
    getActionResults: vi.fn().mockReturnValue([]),
    evaluate: vi.fn().mockResolvedValue(null),

    // State methods
    composeState: vi
      .fn()
      .mockImplementation(async (_message: Memory, _providers?: string[]) => ({
        values: {
          agentName: "Test Agent",
          recentMessages: "User: Test message",
        },
        data: {
          room: {
            id: "test-room-id" as UUID,
            type: ChannelType.GROUP,
            worldId: "test-world-id" as UUID,
            serverId: "test-server-id" as UUID,
            source: "test",
          },
        },
        text: "",
      })),

    // Connection methods
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    ensureConnections: vi.fn().mockResolvedValue(undefined),
    ensureParticipantInRoom: vi.fn().mockResolvedValue(undefined),
    ensureWorldExists: vi.fn().mockResolvedValue(undefined),
    ensureRoomExists: vi.fn().mockResolvedValue(undefined),
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),

    // Task methods
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(null),
    getTasksByName: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue("task-id" as UUID),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    registerTaskWorker: vi.fn(),
    getTaskWorker: vi.fn().mockReturnValue(undefined),

    // Cache methods
    getCache: vi.fn().mockResolvedValue(undefined),
    setCache: vi.fn().mockResolvedValue(true),
    deleteCache: vi.fn().mockResolvedValue(true),

    // Log methods
    log: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue([]),
    deleteLog: vi.fn().mockResolvedValue(undefined),

    // Run tracking methods
    createRunId: vi.fn().mockReturnValue("test-run-id" as UUID),
    startRun: vi.fn().mockReturnValue("test-run-id" as UUID),
    endRun: vi.fn(),
    getCurrentRunId: vi.fn().mockReturnValue("test-run-id" as UUID),

    // Messaging methods
    registerSendHandler: vi.fn(),
    sendMessageToTarget: vi.fn().mockResolvedValue(undefined),

    // Lifecycle
    stop: vi.fn().mockResolvedValue(undefined),

    // Apply overrides last to allow customization
    ...overrides,
  } as IAgentRuntime;

  return baseRuntime;
}

/**
 * Creates a real AgentRuntime for integration testing.
 * Uses actual runtime logic with mocked database adapter.
 */
export async function createTestRuntime(
  options: {
    character?: Partial<Character>;
    adapter?: IDatabaseAdapter;
    plugins?: Plugin[];
    skipInitialize?: boolean;
  } = {},
): Promise<IAgentRuntime> {
  const character = createTestCharacter(options.character);
  const agentId = character.id || createUUID();
  const adapter = options.adapter || createMockDatabaseAdapter(agentId);

  const runtime = new AgentRuntime({
    agentId,
    character,
    adapter,
    plugins: options.plugins,
  });

  if (!options.skipInitialize) {
    await runtime.initialize();
  }

  return runtime;
}

/**
 * Creates a mock Memory object for testing
 */
export function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  const id = createUUID();
  return {
    id,
    roomId: overrides.roomId || ("test-room-id" as UUID),
    entityId: overrides.entityId || ("test-entity-id" as UUID),
    agentId: overrides.agentId || ("test-agent-id" as UUID),
    content: {
      text: "Test message",
      channelType: ChannelType.GROUP,
      ...overrides.content,
    } as Content,
    createdAt: Date.now(),
    metadata: { type: MemoryType.MESSAGE } as MemoryMetadata,
    ...overrides,
  };
}

// Alias for backward compatibility
export const createTestMemory = createMockMemory;

/**
 * Creates a mock State object for testing
 */
export function createMockState(overrides: Partial<State> = {}): State {
  return {
    values: {
      agentName: "Test Agent",
      recentMessages: "User: Test message",
      ...overrides.values,
    },
    data: {
      room: {
        id: "test-room-id" as UUID,
        type: ChannelType.GROUP,
        worldId: "test-world-id" as UUID,
        serverId: "test-server-id" as UUID,
        source: "test",
      },
      ...overrides.data,
    },
    text: "",
    ...overrides,
  };
}

// Alias for backward compatibility
export const createTestState = createMockState;

/**
 * Creates a mock Room object for testing
 */
export function createMockRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: createUUID(),
    name: "Test Room",
    worldId: createUUID(),
    serverId: createUUID(),
    source: "test",
    type: ChannelType.GROUP,
    ...overrides,
  };
}

/**
 * Creates a standardized setup for action tests with consistent objects.
 */
export function setupActionTest(options?: {
  runtimeOverrides?: Partial<IAgentRuntime>;
  messageOverrides?: Partial<Memory>;
  stateOverrides?: Partial<State>;
}) {
  const agentId = "test-agent-id" as UUID;
  const roomId = "test-room-id" as UUID;
  const entityId = "test-entity-id" as UUID;

  // Create mock runtime with any overrides
  const mockRuntime = createMockRuntime({
    agentId,
    ...options?.runtimeOverrides,
  });

  // Create message
  const mockMessage = createMockMemory({
    roomId,
    entityId,
    agentId,
    ...options?.messageOverrides,
  });

  // Create state
  const mockState = createMockState({
    data: {
      room: {
        id: roomId,
        type: ChannelType.GROUP,
        worldId: "test-world-id" as UUID,
        serverId: "test-server-id" as UUID,
        source: "test",
      },
    },
    ...options?.stateOverrides,
  });

  // Create callback function
  const callbackFn = vi.fn().mockResolvedValue([] as Memory[]);

  return {
    mockRuntime,
    mockMessage,
    mockState,
    callbackFn,
    agentId,
    roomId,
    entityId,
  };
}

/**
 * Cleans up a test runtime
 */
export async function cleanupTestRuntime(
  runtime: IAgentRuntime,
): Promise<void> {
  try {
    await runtime.stop();
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Helper to wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeout = 5000,
  interval = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}
