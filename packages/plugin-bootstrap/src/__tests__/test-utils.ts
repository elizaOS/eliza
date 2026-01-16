import { mock } from 'bun:test';
import {
  Action,
  Character,
  ChannelType,
  Content,
  Evaluator,
  IDatabaseAdapter,
  IAgentRuntime,
  Memory,
  ModelType,
  Plugin,
  Provider,
  Route,
  Service,
  State,
  UUID,
} from '@elizaos/core';

/**
 * Creates a comprehensive mock of the IAgentRuntime interface with sensible defaults
 * that can be overridden as needed for specific tests.
 *
 * @param overrides - Optional overrides for the default mock methods and properties
 * @returns A mock runtime for testing
 */
export function createMockRuntime(overrides: Partial<MockRuntime> = {}): MockRuntime {
  // Create base mock runtime with defaults
  const mockRuntime: MockRuntime = {
    // Core properties
    agentId: 'test-agent-id' as UUID,
    initPromise: Promise.resolve(),
    character: {
      name: 'Test Agent',
      bio: 'This is a test agent for unit tests',
      tone: 'helpful',
      templates: {
        reflectionTemplate: 'Test reflection template {{recentMessages}}',
        messageHandlerTemplate: 'Test message handler template {{recentMessages}}',
        shouldRespondTemplate: 'Test should respond template {{recentMessages}}',
      },
    } as Character,
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [],
    services: new Map(),
    events: new Map(),
    routes: [],
    logger: {
      debug: mock(),
      warn: mock(),
      error: mock(),
      info: mock(),
    },

    // Core methods
    registerPlugin: mock().mockResolvedValue(undefined),
    initialize: mock().mockResolvedValue(undefined),
    getKnowledge: mock().mockResolvedValue([]),
    addKnowledge: mock().mockResolvedValue(undefined),
    getService: mock().mockReturnValue(null),
    getAllServices: mock().mockReturnValue(new Map()),
    registerService: mock(),
    registerDatabaseAdapter: mock(),
    setSetting: mock(),
    getSetting: mock().mockReturnValue(null),
    getConversationLength: mock().mockReturnValue(10),
    processActions: mock().mockResolvedValue(undefined),
    evaluate: mock().mockResolvedValue([]),
    registerProvider: mock(),
    registerAction: mock(),
    registerEvaluator: mock(),
    ensureConnection: mock().mockResolvedValue(undefined),
    ensureParticipantInRoom: mock().mockResolvedValue(undefined),
    ensureWorldExists: mock().mockResolvedValue(undefined),
    ensureRoomExists: mock().mockResolvedValue(undefined),

    // Common database operations
    db: {},
    init: mock().mockResolvedValue(undefined),
    close: mock().mockResolvedValue(undefined),
    getAgent: mock().mockResolvedValue(null),
    getAgents: mock().mockResolvedValue([]),
    createAgent: mock().mockResolvedValue(true),
    updateAgent: mock().mockResolvedValue(true),
    deleteAgent: mock().mockResolvedValue(true),
    ensureAgentExists: mock().mockResolvedValue(undefined),
    ensureEmbeddingDimension: mock().mockResolvedValue(undefined),
    getEntityById: mock().mockResolvedValue(null),
    getEntitiesForRoom: mock().mockResolvedValue([]),
    createEntity: mock().mockResolvedValue(true),
    updateEntity: mock().mockResolvedValue(undefined),
    getComponent: mock().mockResolvedValue(null),
    getComponents: mock().mockResolvedValue([]),
    createComponent: mock().mockResolvedValue(true),
    updateComponent: mock().mockResolvedValue(undefined),
    deleteComponent: mock().mockResolvedValue(undefined),
    getMemories: mock().mockImplementation((params) => {
      // For facts provider tests
      if (params?.tableName === 'facts' && params?.entityId === 'test-entity-id') {
        return Promise.resolve([
          {
            id: 'memory-1' as UUID,
            entityId: 'entity-1' as UUID,
            agentId: 'agent-1' as UUID,
            roomId: 'room-1' as UUID,
            content: { text: 'User likes chocolate' },
            embedding: [0.1, 0.2, 0.3],
            createdAt: Date.now(),
          },
          {
            id: 'memory-2' as UUID,
            entityId: 'entity-1' as UUID,
            agentId: 'agent-1' as UUID,
            roomId: 'room-1' as UUID,
            content: { text: 'User dislikes spicy food' },
            embedding: [0.2, 0.3, 0.4],
            createdAt: Date.now(),
          },
        ]);
      }
      return Promise.resolve([]);
    }),
    getMemoryById: mock().mockResolvedValue(null),
    getMemoriesByIds: mock().mockResolvedValue([]),

    // Additional methods commonly used in tests
    useModel: mock().mockImplementation((modelType, _params) => {
      if (modelType === ModelType.OBJECT_LARGE) {
        return Promise.resolve({
          thought: 'I should respond in a friendly way',
          message: 'Hello there! How can I help you today?',
        });
      } else if (modelType === ModelType.TEXT_SMALL) {
        return Promise.resolve('yes');
      } else if (modelType === ModelType.TEXT_EMBEDDING) {
        return Promise.resolve([0.1, 0.2, 0.3, 0.4, 0.5]);
      } else if (modelType === ModelType.IMAGE_DESCRIPTION) {
        return Promise.resolve(`<response>
  <title>Test Image</title>
  <description>A test image description</description>
  <text>This is a test image description generated by the mock runtime.</text>
</response>`);
      }
      return Promise.resolve({});
    }),
    composePrompt: mock().mockReturnValue('Composed prompt'),
    composeState: mock().mockResolvedValue({ values: {}, data: {} }),
    createMemory: mock().mockResolvedValue('memory-id' as UUID),
    getRoom: mock().mockResolvedValue({
      id: 'room-id',
      name: 'Test Room',
      worldId: 'test-world-id',
      messageServerId: 'test-server-id',
    }),
    getRooms: mock().mockResolvedValue([
      {
        id: 'room-id',
        name: 'Test Room',
        worldId: 'test-world-id',
        messageServerId: 'test-server-id',
      },
    ]),
    getRoomsByIds: mock().mockResolvedValue([
      {
        id: 'room-id',
        name: 'Test Room',
        worldId: 'test-world-id',
        messageServerId: 'test-server-id',
      },
    ]),
    getWorld: mock().mockResolvedValue({
      id: 'test-world-id',
      name: 'Test World',
      messageServerId: 'test-server-id',
      metadata: {
        roles: {
          'test-entity-id': 'ADMIN',
          'test-agent-id': 'OWNER',
        },
        settings: [
          { name: 'setting1', value: 'value1', description: 'Description 1' },
          { name: 'setting2', value: 'value2', description: 'Description 2' },
        ],
      },
    }),
    addEmbeddingToMemory: mock().mockResolvedValue({
      id: 'memory-id',
      entityId: 'test-entity-id',
      roomId: 'test-room-id',
      content: { text: 'Test fact' },
    }),
    queueEmbeddingGeneration: mock().mockResolvedValue(undefined),
    getModel: mock().mockImplementation((modelType: string) => {
      // By default, return a mock handler for TEXT_EMBEDDING
      if (modelType === ModelType.TEXT_EMBEDDING) {
        return mock().mockResolvedValue([0.1, 0.2, 0.3, 0.4, 0.5]);
      }
      return mock().mockResolvedValue({});
    }),
    createRelationship: mock().mockResolvedValue(true),
    updateRelationship: mock().mockResolvedValue(true),
    getRelationships: mock().mockResolvedValue([]),
    addRelationship: mock().mockResolvedValue(true),
    getTasks: mock().mockResolvedValue([]),
    getTasksByName: mock().mockResolvedValue([]),
    createTask: mock().mockResolvedValue({ id: 'task-id' }),
    updateTasks: mock().mockResolvedValue([]),
    deleteTasks: mock().mockResolvedValue([]),
    deleteTask: mock().mockResolvedValue(true),
    emitEvent: mock().mockResolvedValue(undefined),
    registerEvent: mock(),
    getCache: mock().mockResolvedValue(null),
    setCache: mock().mockResolvedValue(true),
    log: mock().mockResolvedValue(undefined),

    // Task-related methods needed for TaskService tests
    registerTaskWorker: mock(),
    getTaskWorker: mock().mockReturnValue({
      name: 'test-worker',
      validate: mock().mockResolvedValue(true),
      execute: mock().mockResolvedValue({}),
    }),
    getParticipantUserState: mock().mockResolvedValue('ACTIVE'),
    setParticipantUserState: mock().mockResolvedValue(undefined),
    updateParticipantUserState: mock().mockResolvedValue(undefined),
    getUserServerRole: mock().mockResolvedValue('USER'),
    findEntityByName: mock().mockResolvedValue(null),
    getMemberRole: mock().mockResolvedValue('USER'),

    // Methods missing in the original implementation
    searchMemories: mock().mockResolvedValue([
      {
        id: 'memory-1' as UUID,
        entityId: 'entity-1' as UUID,
        agentId: 'agent-1' as UUID,
        roomId: 'room-1' as UUID,
        content: { text: 'User likes chocolate' },
        embedding: [0.1, 0.2, 0.3],
        createdAt: Date.now(),
        similarity: 0.95,
      },
    ]),
    getRoomsForParticipants: mock().mockResolvedValue([
      {
        id: 'room-id',
        name: 'Test Room',
        worldId: 'test-world-id',
        messageServerId: 'test-server-id',
      },
    ]),
    getRoomsForEntity: mock().mockResolvedValue([
      {
        id: 'room-id',
        name: 'Test Room',
        worldId: 'test-world-id',
        messageServerId: 'test-server-id',
      },
    ]),
    searchEntities: mock().mockResolvedValue([
      { id: 'test-entity-id', names: ['Test Entity'], worldId: 'test-world-id' },
    ]),
    searchRooms: mock().mockResolvedValue([
      { id: 'room-id', name: 'Test Room', worldId: 'test-world-id' },
    ]),
    getEntity: mock().mockResolvedValue({
      id: 'test-entity-id',
      names: ['Test Entity'],
      worldId: 'test-world-id',
    }),
    getWorldSettings: mock().mockResolvedValue([
      { name: 'setting1', value: 'value1', description: 'Description 1' },
      { name: 'setting2', value: 'value2', description: 'Description 2' },
    ]),
    findWorldsForOwner: mock().mockResolvedValue([
      { id: 'test-world-id', name: 'Test World', messageServerId: 'test-server-id' },
    ]),

    // File, PDF, and Image service methods
    uploadFile: mock().mockResolvedValue({ id: 'file-id', name: 'test.txt' }),
    getFile: mock().mockResolvedValue({ id: 'file-id', content: 'Test file content' }),
    listFiles: mock().mockResolvedValue([{ id: 'file-id', name: 'test.txt' }]),
    deleteFile: mock().mockResolvedValue(true),
    extractTextFromPDF: mock().mockResolvedValue('Extracted text from PDF'),
    describeImage: mock().mockResolvedValue('An image description'),

    // Added for recentMessages provider
    getMemoriesByRoomIds: mock().mockResolvedValue([
      {
        id: 'memory-1' as UUID,
        entityId: 'test-entity-id' as UUID,
        agentId: 'test-agent-id' as UUID,
        roomId: 'test-room-id' as UUID,
        content: {
          text: 'Hello there!',
          channelType: ChannelType.GROUP,
        },
        createdAt: Date.now() - 1000,
      },
      {
        id: 'memory-2' as UUID,
        entityId: 'test-agent-id' as UUID,
        agentId: 'test-agent-id' as UUID,
        roomId: 'test-room-id' as UUID,
        content: {
          text: 'How can I help you?',
          channelType: ChannelType.GROUP,
        },
        createdAt: Date.now(),
      },
    ]),

    // Run tracking methods required by IAgentRuntime
    createRunId: mock().mockReturnValue('test-run-id' as UUID),
    startRun: mock().mockReturnValue('test-run-id' as UUID),
    endRun: mock().mockReturnValue(undefined),
    getCurrentRunId: mock().mockReturnValue('test-run-id' as UUID),

    // State cache for multi-step functionality
    stateCache: {
      get: mock().mockReturnValue(null),
      set: mock().mockReturnValue(undefined),
    },
  };

  // Merge with overrides
  return { ...mockRuntime, ...overrides };
}

/**
 * Creates a mock Memory object for testing
 *
 * @param overrides - Optional overrides for the default memory properties
 * @returns A mock memory object
 */
export function createMockMemory(overrides: Partial<Memory> = {}): Partial<Memory> {
  return {
    id: 'test-message-id' as UUID,
    roomId: 'test-room-id' as UUID,
    entityId: 'test-entity-id' as UUID,
    agentId: 'test-agent-id' as UUID,
    content: {
      text: 'Test message',
      channelType: ChannelType.GROUP,
    } as Content,
    createdAt: Date.now(),
    ...overrides,
  };
}

/**
 * Creates a mock State object for testing
 *
 * @param overrides - Optional overrides for the default state properties
 * @returns A mock state object
 */
export function createMockState(overrides: Partial<State> = {}): Partial<State> {
  return {
    values: {
      agentName: 'Test Agent',
      recentMessages: 'User: Test message',
      ...overrides.values,
    },
    data: {
      room: {
        id: 'test-room-id',
        type: ChannelType.GROUP,
        worldId: 'test-world-id',
        messageServerId: 'test-server-id',
      },
      ...overrides.data,
    },
    ...overrides,
  };
}

/**
 * Creates a mock Service object for testing
 *
 * @param overrides - Optional overrides for the default service properties
 * @returns A mock service object
 */
export function createMockService(overrides: Partial<Record<string, any>> = {}): any {
  return {
    name: 'mock-service',
    type: 'mock',
    execute: mock().mockResolvedValue({}),
    init: mock().mockResolvedValue({}),
    ...overrides,
  };
}

/**
 * Creates a standardized setup for action tests with consistent mock objects
 * This replaces the setupActionTest function in actions.test.ts
 *
 * @param overrides - Optional overrides for default mock implementations
 * @returns An object containing mockRuntime, mockMessage, mockState, and callbackFn
 */
export function setupActionTest(options?: {
  runtimeOverrides?: Partial<MockRuntime>;
  messageOverrides?: Partial<Memory>;
  stateOverrides?: Partial<State>;
}) {
  const mockRuntime = createMockRuntime(options?.runtimeOverrides);
  const mockMessage = createMockMemory(options?.messageOverrides);
  const mockState = createMockState(options?.stateOverrides);
  const callbackFn = mock().mockResolvedValue([] as Memory[]); // Explicitly type the return value

  return {
    mockRuntime,
    mockMessage,
    mockState,
    callbackFn,
  };
}

/**
 * Type definition for the mock runtime to ensure type safety in tests
 */
export type MockRuntime = Partial<IAgentRuntime & IDatabaseAdapter> & {
  agentId: UUID;
  initPromise: Promise<void>;
  character: Character;
  providers: Provider[];
  actions: Action[];
  evaluators: Evaluator[];
  plugins: Plugin[];
  services: Map<string, Service>;
  events: Map<string, ((params: any) => Promise<void>)[]>;
  routes: Route[];
  logger: {
    debug: ReturnType<typeof mock>;
    warn: ReturnType<typeof mock>;
    error: ReturnType<typeof mock>;
    info: ReturnType<typeof mock>;
  };

  // Additional properties and methods commonly used in tests
  useModel: ReturnType<typeof mock>;
  getModel: ReturnType<typeof mock>;
  composePrompt: ReturnType<typeof mock>;
  composeState: ReturnType<typeof mock>;
  createMemory: ReturnType<typeof mock>;
  getRoom: ReturnType<typeof mock>;
  getRooms: ReturnType<typeof mock>;
  getRoomsByIds: ReturnType<typeof mock>;
  getWorld: ReturnType<typeof mock>;
  addEmbeddingToMemory: ReturnType<typeof mock>;
  createRelationship: ReturnType<typeof mock>;
  updateRelationship: ReturnType<typeof mock>;
  getRelationships: ReturnType<typeof mock>;
  addRelationship: ReturnType<typeof mock>;
  getTasks: ReturnType<typeof mock>;
  getTasksByName: ReturnType<typeof mock>;
  createTask: ReturnType<typeof mock>;
  updateTasks: ReturnType<typeof mock>;
  deleteTasks: ReturnType<typeof mock>;
  deleteTask: ReturnType<typeof mock>;
  emitEvent: ReturnType<typeof mock>;
  registerEvent: ReturnType<typeof mock>;
  getCache: ReturnType<typeof mock>;
  setCache: ReturnType<typeof mock>;

  // Knowledge methods
  getKnowledge: ReturnType<typeof mock>;
  addKnowledge: ReturnType<typeof mock>;

  // Task-related methods
  registerTaskWorker: ReturnType<typeof mock>;
  getTaskWorker: ReturnType<typeof mock>;

  // Additional methods used in action tests
  updateParticipantUserState: ReturnType<typeof mock>;
  getUserServerRole: ReturnType<typeof mock>;
  findEntityByName: ReturnType<typeof mock>;
  getParticipantUserState: ReturnType<typeof mock>;
  setParticipantUserState: ReturnType<typeof mock>;
  getMemberRole: ReturnType<typeof mock>;

  // Methods that were missing from the original implementation
  searchMemories: ReturnType<typeof mock>;
  getRoomsForParticipants: ReturnType<typeof mock>;
  getRoomsForEntity: ReturnType<typeof mock>;
  searchEntities: ReturnType<typeof mock>;
  searchRooms: ReturnType<typeof mock>;
  getEntity: ReturnType<typeof mock>;
  getWorldSettings: ReturnType<typeof mock>;
  findWorldsForOwner: ReturnType<typeof mock>;

  // State cache for multi-step functionality
  stateCache: {
    get: ReturnType<typeof mock>;
    set: ReturnType<typeof mock>;
  };

  // File, PDF, and Image service methods
  uploadFile: ReturnType<typeof mock>;
  getFile: ReturnType<typeof mock>;
  listFiles: ReturnType<typeof mock>;
  deleteFile: ReturnType<typeof mock>;
  extractTextFromPDF: ReturnType<typeof mock>;
  describeImage: ReturnType<typeof mock>;

  // Added for recentMessages provider
  getMemoriesByRoomIds: ReturnType<typeof mock>;

  // Add this line in the appropriate section with other database methods
  ensureAgentExists: ReturnType<typeof mock>;
};
