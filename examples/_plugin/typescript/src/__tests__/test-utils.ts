import {
  asUUID,
  type Character,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type ModelTypeName,
  type Service,
  type ServiceTypeName,
  type State,
  type UUID,
} from "@elizaos/core";
import { vi } from "vitest";

/**
 * Creates a UUID for testing
 */
export function createUUID(): UUID {
  return asUUID(crypto.randomUUID());
}

/**
 * Creates a test character
 */
export function createTestCharacter(
  overrides: Partial<Character> = {},
): Character {
  return {
    id: createUUID(),
    name: "Test Character",
    username: "test-character",
    bio: "A test character for unit testing",
    system: "You are a helpful assistant for testing.",
    plugins: [],
    settings: {},
    messageExamples: [],
    topics: [],
    adjectives: [],
    style: { all: [], chat: [], post: [] },
    secrets: {},
    ...overrides,
  };
}

/**
 * Creates a test memory
 */
export function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const now = Date.now();
  return {
    id: createUUID(),
    agentId: createUUID(),
    entityId: createUUID(),
    roomId: createUUID(),
    content: {
      text: "Test message",
      source: "test",
    },
    createdAt: now,
    ...overrides,
  };
}

/**
 * Creates a test state
 */
export function createTestState(overrides: Partial<State> = {}): State {
  return {
    agentId: createUUID(),
    roomId: createUUID(),
    userId: createUUID(),
    bio: "Test bio",
    lore: "Test lore",
    userName: "Test User",
    userBio: "Test user bio",
    actors: "",
    recentMessages: "",
    recentInteractions: "",
    goals: "Test goals",
    image: "",
    messageDirections: "",
    values: {},
    data: {},
    text: "",
    ...overrides,
  };
}

/**
 * Helper to create a mock function
 */
function _createMockFn<T extends (...args: any[]) => any>(
  implementation?: T,
): ReturnType<typeof vi.fn> {
  return vi.fn(implementation || (() => {}));
}

/**
 * Creates a properly typed mock runtime
 */
export function createMockRuntime(
  overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
  const agentId = overrides.agentId || createUUID();
  const character = overrides.character || createTestCharacter();

  // Create base runtime object with all required properties
  const mockRuntime: IAgentRuntime = {
    // Properties
    agentId,
    initPromise: Promise.resolve(),
    character,
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [],
    services: new Map<ServiceTypeName, Service[]>(),
    events: new Map(),
    fetch: null,
    routes: [],
    logger: {
      info: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      debug: vi.fn(() => {}),
    },
    db: {},

    // Database methods
    initialize: vi.fn().mockResolvedValue(undefined),
    init: vi.fn().mockResolvedValue(undefined),
    runMigrations: vi.fn().mockResolvedValue(undefined),
    isReady: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    getConnection: vi.fn().mockResolvedValue({}),

    // Agent methods
    getAgent: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    createAgent: vi.fn().mockResolvedValue(true),
    updateAgent: vi.fn().mockResolvedValue(true),
    deleteAgent: vi.fn().mockResolvedValue(true),

    // Memory methods
    createMemory: vi.fn().mockImplementation(async (memory: Memory) => ({
      ...memory,
      id: memory.id || createUUID(),
    })),
    getMemories: vi.fn().mockResolvedValue([]),
    getMemoryById: vi.fn().mockResolvedValue(null),
    getMemoriesByIds: vi.fn().mockResolvedValue([]),
    getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
    searchMemories: vi.fn().mockResolvedValue([]),

    addEmbeddingToMemory: vi
      .fn()
      .mockImplementation(async (memory: Memory) => memory),
    queueEmbeddingGeneration: vi.fn().mockResolvedValue(undefined),
    getAllMemories: vi.fn().mockResolvedValue([]),
    clearAllAgentMemories: vi.fn().mockResolvedValue(undefined),
    updateMemory: vi.fn().mockResolvedValue(true),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteManyMemories: vi.fn().mockResolvedValue(undefined),
    deleteAllMemories: vi.fn().mockResolvedValue(undefined),
    countMemories: vi.fn().mockResolvedValue(0),

    // Entity methods
    getEntitiesByIds: vi.fn().mockResolvedValue([]),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    createEntities: vi.fn().mockResolvedValue(true),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    createEntity: vi.fn().mockResolvedValue(true),
    getEntityById: vi.fn().mockResolvedValue(null),

    // Room methods
    createRoom: vi.fn().mockImplementation(async () => createUUID()),
    createRooms: vi.fn().mockImplementation(async () => [createUUID()]),
    getRoom: vi.fn().mockResolvedValue(null),
    getRooms: vi.fn().mockResolvedValue([]),
    getRoomsByIds: vi.fn().mockResolvedValue([]),
    getRoomsByWorld: vi.fn().mockResolvedValue([]),
    updateRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoom: vi.fn().mockResolvedValue(undefined),
    deleteRoomsByWorldId: vi.fn().mockResolvedValue(undefined),
    addParticipant: vi.fn().mockResolvedValue(true),
    addParticipantsRoom: vi.fn().mockResolvedValue(true),
    removeParticipant: vi.fn().mockResolvedValue(true),
    getRoomsForParticipant: vi.fn().mockResolvedValue([]),
    getRoomsForParticipants: vi.fn().mockResolvedValue([]),
    getParticipantsForEntity: vi.fn().mockResolvedValue([]),
    getParticipantsForRoom: vi.fn().mockResolvedValue([]),
    getParticipantUserState: vi.fn().mockResolvedValue(null),
    setParticipantUserState: vi.fn().mockResolvedValue(undefined),

    // Service methods
    getService: vi.fn().mockReturnValue(null),
    getServicesByType: vi.fn().mockReturnValue([]),
    getAllServices: vi.fn().mockReturnValue(new Map()),
    registerService: vi.fn().mockResolvedValue(undefined),
    getRegisteredServiceTypes: vi.fn().mockReturnValue([]),
    hasService: vi.fn().mockReturnValue(false),
    getServiceLoadPromise: vi.fn().mockResolvedValue(null),

    // Plugin/Action/Provider methods
    registerPlugin: vi.fn().mockResolvedValue(undefined),
    registerProvider: vi.fn().mockReturnValue(undefined),
    registerAction: vi.fn().mockReturnValue(undefined),
    registerEvaluator: vi.fn().mockReturnValue(undefined),

    // Model methods
    registerModel: vi.fn().mockReturnValue(undefined),
    getModel: vi.fn().mockReturnValue(undefined),
    useModel: vi.fn().mockImplementation(async (modelType: ModelTypeName) => {
      if (modelType === ModelType.TEXT_SMALL) {
        return "Never gonna give you up, never gonna let you down";
      } else if (modelType === ModelType.TEXT_LARGE) {
        return "Never gonna make you cry, never gonna say goodbye";
      }
      return "Default model response";
    }),

    // Event methods
    registerEvent: vi.fn().mockReturnValue(undefined),
    getEvent: vi.fn().mockReturnValue(undefined),
    emitEvent: vi.fn().mockResolvedValue(undefined),

    // Settings methods
    setSetting: vi.fn().mockReturnValue(undefined),
    getSetting: vi.fn().mockImplementation((key: string) => {
      if (key === "EXAMPLE_PLUGIN_VARIABLE") return "test-value";
      return null;
    }),

    // Other methods
    processActions: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(null),
    ensureConnections: vi.fn().mockResolvedValue(undefined),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getConversationLength: vi.fn().mockReturnValue(10),
    composeState: vi.fn().mockImplementation(async () => createTestState()),
    // Task methods
    getTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue(null),
    getTasksByName: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockImplementation(async () => createUUID()),
    updateTask: vi.fn().mockResolvedValue(undefined),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    registerTaskWorker: vi.fn().mockReturnValue(undefined),
    getTaskWorker: vi.fn().mockReturnValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createRunId: vi.fn().mockImplementation(() => createUUID()),
    startRun: vi.fn().mockImplementation(() => createUUID()),
    endRun: vi.fn().mockReturnValue(undefined),
    getCurrentRunId: vi.fn().mockImplementation(() => createUUID()),
    registerSendHandler: vi.fn().mockReturnValue(undefined),
    sendMessageToTarget: vi.fn().mockResolvedValue(undefined),
    registerDatabaseAdapter: vi.fn().mockReturnValue(undefined),
    log: vi.fn().mockResolvedValue(undefined),
    getLogs: vi.fn().mockResolvedValue([]),
    deleteLog: vi.fn().mockResolvedValue(undefined),

    // Component methods (from IDatabaseAdapter)
    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponent: vi.fn().mockResolvedValue(true),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),

    // Relationship methods
    createRelationship: vi.fn().mockResolvedValue(true),
    getRelationships: vi.fn().mockResolvedValue([]),

    getRelationship: vi.fn().mockResolvedValue(null),
    updateRelationship: vi.fn().mockResolvedValue(undefined),

    // Embedding methods
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
    getCachedEmbeddings: vi.fn().mockResolvedValue([]),

    // World methods
    getWorld: vi.fn().mockResolvedValue(null),
    createWorld: vi.fn().mockImplementation(async () => createUUID()),
    updateWorld: vi.fn().mockResolvedValue(undefined),
    removeWorld: vi.fn().mockResolvedValue(undefined),
    getAllWorlds: vi.fn().mockResolvedValue([]),

    // Required method that was missing
    ensureParticipantInRoom: vi.fn().mockResolvedValue(undefined),
    ensureWorldExists: vi.fn().mockResolvedValue(undefined),
    ensureRoomExists: vi.fn().mockResolvedValue(undefined),

    // Cache methods
    getCache: vi.fn().mockResolvedValue(undefined),
    setCache: vi.fn().mockResolvedValue(true),
    deleteCache: vi.fn().mockResolvedValue(true),

    // Other missing database methods
    getMemoriesByWorldId: vi.fn().mockResolvedValue([]),

    // Apply any overrides
    ...overrides,
  };

  // Setup logger spies if not already overridden
  if (!overrides.logger) {
    vi.spyOn(logger, "info").mockImplementation(() => {});
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(logger, "debug").mockImplementation(() => {});
  }

  return mockRuntime;
}

/**
 * Creates test fixtures for event payloads
 */
export const testFixtures = {
  messagePayload: (overrides: any = {}) => ({
    content: {
      text: "Test message",
      source: "test",
    },
    userId: createUUID(),
    roomId: createUUID(),
    runtime: createMockRuntime(),
    source: "test",
    ...overrides,
  }),

  worldPayload: (overrides: any = {}) => ({
    content: {
      text: "World event",
      world: "test-world",
    },
    userId: createUUID(),
    roomId: createUUID(),
    runtime: createMockRuntime(),
    source: "test",
    ...overrides,
  }),
};

/**
 * Type guard to check if a value is a mock function
 */
export function isMockFunction(value: any): value is ReturnType<typeof vi.fn> {
  return value && typeof value.mock === "object";
}

/**
 * Helper to assert spy was called with specific arguments
 */
export function assertSpyCalledWith(spy: any, ...args: any[]) {
  if (!isMockFunction(spy)) {
    throw new Error("Not a mock function");
  }

  const calls = spy.mock.calls;
  const found = calls.some((call: any[]) =>
    args.every((arg, index) => {
      if (typeof arg === "object" && arg !== null) {
        return JSON.stringify(arg) === JSON.stringify(call[index]);
      }
      return arg === call[index];
    }),
  );

  if (!found) {
    throw new Error(
      `Spy was not called with expected arguments: ${JSON.stringify(args)}`,
    );
  }
}

/**
 * Setup logger spies for testing
 */
export function setupLoggerSpies() {
  vi.spyOn(logger, "info").mockImplementation(() => {});
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  vi.spyOn(logger, "error").mockImplementation(() => {});
  vi.spyOn(logger, "debug").mockImplementation(() => {});
}

/**
 * Type definition for the mock runtime (for backward compatibility)
 */
export type MockRuntime = IAgentRuntime;
