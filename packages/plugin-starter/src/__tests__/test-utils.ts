import { mock, spyOn } from 'bun:test';
import {
  type IAgentRuntime,
  type Memory,
  type Entity,
  type Room,
  type World,
  type State,
  type Content,
  type UUID,
  type Character,
  type Provider,
  type Action,
  type Evaluator,
  type Plugin,
  type Service,
  type ServiceTypeName,
  type Route,
  type HandlerCallback,
  type SendHandlerFunction,
  type TargetInfo,
  type ModelTypeName,
  type TaskWorker,
  type Component,
  type Relationship,
  ModelType,
  asUUID,
  logger,
} from '@elizaos/core';

/**
 * Creates a UUID for testing
 */
export function createUUID(): UUID {
  return asUUID(crypto.randomUUID());
}

/**
 * Creates a test character
 */
export function createTestCharacter(overrides: Partial<Character> = {}): Character {
  return {
    id: createUUID(),
    name: 'Test Character',
    username: 'test-character',
    bio: 'A test character for unit testing',
    system: 'You are a helpful assistant for testing.',
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
      text: 'Test message',
      source: 'test',
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
    bio: 'Test bio',
    lore: 'Test lore',
    userName: 'Test User',
    userBio: 'Test user bio',
    actors: '',
    recentMessages: '',
    recentInteractions: '',
    goals: 'Test goals',
    image: '',
    messageDirections: '',
    values: {},
    data: {},
    text: '',
    ...overrides,
  };
}

/**
 * Helper to create a mock function
 */
function createMockFn<T extends (...args: any[]) => any>(
  implementation?: T
): ReturnType<typeof mock> {
  return mock(implementation || (() => {}));
}

/**
 * Creates a properly typed mock runtime
 */
export function createMockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  const agentId = overrides.agentId || createUUID();
  const character = overrides.character || createTestCharacter();

  // Create base runtime object with all required properties
  const mockRuntime: IAgentRuntime = {
    // Properties
    agentId,
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
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    },
    db: {},

    // Database methods
    initialize: mock().mockResolvedValue(undefined),
    init: mock().mockResolvedValue(undefined),
    runMigrations: mock().mockResolvedValue(undefined),
    isReady: mock().mockResolvedValue(true),
    close: mock().mockResolvedValue(undefined),
    getConnection: mock().mockResolvedValue({}),

    // Agent methods
    getAgent: mock().mockResolvedValue(null),
    getAgents: mock().mockResolvedValue([]),
    createAgent: mock().mockResolvedValue(true),
    updateAgent: mock().mockResolvedValue(true),
    deleteAgent: mock().mockResolvedValue(true),

    // Memory methods
    createMemory: mock().mockImplementation(async (memory: Memory) => ({
      ...memory,
      id: memory.id || createUUID(),
    })),
    getMemories: mock().mockResolvedValue([]),
    getMemoryById: mock().mockResolvedValue(null),
    getMemoriesByIds: mock().mockResolvedValue([]),
    getMemoriesByRoomIds: mock().mockResolvedValue([]),
    searchMemories: mock().mockResolvedValue([]),

    addEmbeddingToMemory: mock().mockImplementation(async (memory: Memory) => memory),
    queueEmbeddingGeneration: mock().mockResolvedValue(undefined),
    getAllMemories: mock().mockResolvedValue([]),
    clearAllAgentMemories: mock().mockResolvedValue(undefined),
    updateMemory: mock().mockResolvedValue(true),
    deleteMemory: mock().mockResolvedValue(undefined),
    deleteManyMemories: mock().mockResolvedValue(undefined),
    deleteAllMemories: mock().mockResolvedValue(undefined),
    countMemories: mock().mockResolvedValue(0),

    // Entity methods
    getEntitiesByIds: mock().mockResolvedValue([]),
    getEntitiesForRoom: mock().mockResolvedValue([]),
    createEntities: mock().mockResolvedValue(true),
    updateEntity: mock().mockResolvedValue(undefined),
    createEntity: mock().mockResolvedValue(true),
    getEntityById: mock().mockResolvedValue(null),

    // Room methods
    createRoom: mock().mockImplementation(async () => createUUID()),
    createRooms: mock().mockImplementation(async () => [createUUID()]),
    getRoom: mock().mockResolvedValue(null),
    getRooms: mock().mockResolvedValue([]),
    getRoomsByIds: mock().mockResolvedValue([]),
    getRoomsByWorld: mock().mockResolvedValue([]),
    updateRoom: mock().mockResolvedValue(undefined),
    deleteRoom: mock().mockResolvedValue(undefined),
    deleteRoomsByWorldId: mock().mockResolvedValue(undefined),
    addParticipant: mock().mockResolvedValue(true),
    addParticipantsRoom: mock().mockResolvedValue(true),
    removeParticipant: mock().mockResolvedValue(true),
    getRoomsForParticipant: mock().mockResolvedValue([]),
    getRoomsForParticipants: mock().mockResolvedValue([]),
    getParticipantsForEntity: mock().mockResolvedValue([]),
    getParticipantsForRoom: mock().mockResolvedValue([]),
    getParticipantUserState: mock().mockResolvedValue(null),
    setParticipantUserState: mock().mockResolvedValue(undefined),

    // Service methods
    getService: mock().mockReturnValue(null),
    getServicesByType: mock().mockReturnValue([]),
    getAllServices: mock().mockReturnValue(new Map()),
    registerService: mock().mockResolvedValue(undefined),
    getRegisteredServiceTypes: mock().mockReturnValue([]),
    hasService: mock().mockReturnValue(false),
    getServiceLoadPromise: mock().mockResolvedValue(null),

    // Plugin/Action/Provider methods
    registerPlugin: mock().mockResolvedValue(undefined),
    registerProvider: mock().mockReturnValue(undefined),
    registerAction: mock().mockReturnValue(undefined),
    registerEvaluator: mock().mockReturnValue(undefined),

    // Model methods
    registerModel: mock().mockReturnValue(undefined),
    getModel: mock().mockReturnValue(undefined),
    useModel: mock().mockImplementation(async (modelType: ModelTypeName) => {
      if (modelType === ModelType.TEXT_SMALL) {
        return 'Never gonna give you up, never gonna let you down';
      } else if (modelType === ModelType.TEXT_LARGE) {
        return 'Never gonna make you cry, never gonna say goodbye';
      }
      return 'Default model response';
    }),

    // Event methods
    registerEvent: mock().mockReturnValue(undefined),
    getEvent: mock().mockReturnValue(undefined),
    emitEvent: mock().mockResolvedValue(undefined),

    // Settings methods
    setSetting: mock().mockReturnValue(undefined),
    getSetting: mock().mockImplementation((key: string) => {
      if (key === 'EXAMPLE_PLUGIN_VARIABLE') return 'test-value';
      return null;
    }),

    // Other methods
    processActions: mock().mockResolvedValue(undefined),
    evaluate: mock().mockResolvedValue(null),
    ensureConnections: mock().mockResolvedValue(undefined),
    ensureConnection: mock().mockResolvedValue(undefined),
    getConversationLength: mock().mockReturnValue(10),
    composeState: mock().mockImplementation(async () => createTestState()),
    // Task methods
    getTasks: mock().mockResolvedValue([]),
    getTask: mock().mockResolvedValue(null),
    getTasksByName: mock().mockResolvedValue([]),
    createTask: mock().mockImplementation(async () => createUUID()),
    updateTask: mock().mockResolvedValue(undefined),
    deleteTask: mock().mockResolvedValue(undefined),
    registerTaskWorker: mock().mockReturnValue(undefined),
    getTaskWorker: mock().mockReturnValue(undefined),
    stop: mock().mockResolvedValue(undefined),
    createRunId: mock().mockImplementation(() => createUUID()),
    startRun: mock().mockImplementation(() => createUUID()),
    endRun: mock().mockReturnValue(undefined),
    getCurrentRunId: mock().mockImplementation(() => createUUID()),
    registerSendHandler: mock().mockReturnValue(undefined),
    sendMessageToTarget: mock().mockResolvedValue(undefined),
    registerDatabaseAdapter: mock().mockReturnValue(undefined),
    log: mock().mockResolvedValue(undefined),
    getLogs: mock().mockResolvedValue([]),
    deleteLog: mock().mockResolvedValue(undefined),

    // Component methods (from IDatabaseAdapter)
    getComponent: mock().mockResolvedValue(null),
    getComponents: mock().mockResolvedValue([]),
    createComponent: mock().mockResolvedValue(true),
    updateComponent: mock().mockResolvedValue(undefined),
    deleteComponent: mock().mockResolvedValue(undefined),

    // Relationship methods
    createRelationship: mock().mockResolvedValue(true),
    getRelationships: mock().mockResolvedValue([]),

    getRelationship: mock().mockResolvedValue(null),
    updateRelationship: mock().mockResolvedValue(undefined),

    // Embedding methods
    ensureEmbeddingDimension: mock().mockResolvedValue(undefined),
    getCachedEmbeddings: mock().mockResolvedValue([]),

    // World methods
    getWorld: mock().mockResolvedValue(null),
    createWorld: mock().mockImplementation(async () => createUUID()),
    updateWorld: mock().mockResolvedValue(undefined),
    removeWorld: mock().mockResolvedValue(undefined),
    getAllWorlds: mock().mockResolvedValue([]),

    // Required method that was missing
    ensureParticipantInRoom: mock().mockResolvedValue(undefined),
    ensureWorldExists: mock().mockResolvedValue(undefined),
    ensureRoomExists: mock().mockResolvedValue(undefined),

    // Cache methods
    getCache: mock().mockResolvedValue(undefined),
    setCache: mock().mockResolvedValue(true),
    deleteCache: mock().mockResolvedValue(true),

    // Other missing database methods
    getMemoriesByWorldId: mock().mockResolvedValue([]),

    // Apply any overrides
    ...overrides,
  };

  // Setup logger spies if not already overridden
  if (!overrides.logger) {
    spyOn(logger, 'info').mockImplementation(() => {});
    spyOn(logger, 'warn').mockImplementation(() => {});
    spyOn(logger, 'error').mockImplementation(() => {});
    spyOn(logger, 'debug').mockImplementation(() => {});
  }

  return mockRuntime;
}

/**
 * Creates test fixtures for event payloads
 */
export const testFixtures = {
  messagePayload: (overrides: any = {}) => ({
    content: {
      text: 'Test message',
      source: 'test',
    },
    userId: createUUID(),
    roomId: createUUID(),
    runtime: createMockRuntime(),
    source: 'test',
    ...overrides,
  }),

  worldPayload: (overrides: any = {}) => ({
    content: {
      text: 'World event',
      world: 'test-world',
    },
    userId: createUUID(),
    roomId: createUUID(),
    runtime: createMockRuntime(),
    source: 'test',
    ...overrides,
  }),
};

/**
 * Type guard to check if a value is a mock function
 */
export function isMockFunction(value: any): value is ReturnType<typeof mock> {
  return value && typeof value.mock === 'object';
}

/**
 * Helper to assert spy was called with specific arguments
 */
export function assertSpyCalledWith(spy: any, ...args: any[]) {
  if (!isMockFunction(spy)) {
    throw new Error('Not a mock function');
  }

  const calls = spy.mock.calls;
  const found = calls.some((call: any[]) =>
    args.every((arg, index) => {
      if (typeof arg === 'object' && arg !== null) {
        return JSON.stringify(arg) === JSON.stringify(call[index]);
      }
      return arg === call[index];
    })
  );

  if (!found) {
    throw new Error(`Spy was not called with expected arguments: ${JSON.stringify(args)}`);
  }
}

/**
 * Setup logger spies for testing
 */
export function setupLoggerSpies() {
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
  spyOn(logger, 'error').mockImplementation(() => {});
  spyOn(logger, 'debug').mockImplementation(() => {});
}

/**
 * Type definition for the mock runtime (for backward compatibility)
 */
export type MockRuntime = IAgentRuntime;
