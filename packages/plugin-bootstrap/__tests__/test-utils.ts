import { vi } from 'vitest';
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
  ServiceType,
  State,
  UUID,
  Room,
  World,
  Entity,
  Component,
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

    // Core methods
    registerPlugin: vi.fn().mockResolvedValue(undefined),
    initialize: vi.fn().mockResolvedValue(undefined),
    getKnowledge: vi.fn().mockResolvedValue([]),
    addKnowledge: vi.fn().mockResolvedValue(undefined),
    getService: vi.fn().mockReturnValue(null),
    getAllServices: vi.fn().mockReturnValue(new Map()),
    registerService: vi.fn(),
    registerDatabaseAdapter: vi.fn(),
    setSetting: vi.fn(),
    getSetting: vi.fn().mockReturnValue(null),
    getConversationLength: vi.fn().mockReturnValue(10),
    processActions: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue([]),
    registerProvider: vi.fn(),
    registerAction: vi.fn(),
    registerEvaluator: vi.fn(),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    ensureParticipantInRoom: vi.fn().mockResolvedValue(undefined),
    ensureWorldExists: vi.fn().mockResolvedValue(undefined),
    ensureRoomExists: vi.fn().mockResolvedValue(undefined),

    // Common database operations
    db: {},
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getAgent: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    createAgent: vi.fn().mockResolvedValue(true),
    updateAgent: vi.fn().mockResolvedValue(true),
    deleteAgent: vi.fn().mockResolvedValue(true),
    ensureAgentExists: vi.fn().mockResolvedValue(undefined),
    ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue(null),
    getEntitiesForRoom: vi.fn().mockResolvedValue([]),
    createEntity: vi.fn().mockResolvedValue(true),
    updateEntity: vi.fn().mockResolvedValue(undefined),
    getComponent: vi.fn().mockResolvedValue(null),
    getComponents: vi.fn().mockResolvedValue([]),
    createComponent: vi.fn().mockResolvedValue(true),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    deleteComponent: vi.fn().mockResolvedValue(undefined),
    getMemories: vi.fn().mockImplementation((params) => {
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
    getMemoryById: vi.fn().mockResolvedValue(null),
    getMemoriesByIds: vi.fn().mockResolvedValue([]),

    // Additional methods commonly used in tests
    useModel: vi.fn().mockImplementation((modelType, params) => {
      if (modelType === ModelType.OBJECT_LARGE) {
        return Promise.resolve({
          thought: 'I should respond in a friendly way',
          message: 'Hello there! How can I help you today?',
        });
      } else if (modelType === ModelType.TEXT_SMALL) {
        return Promise.resolve('yes');
      } else if (modelType === ModelType.TEXT_EMBEDDING) {
        return Promise.resolve([0.1, 0.2, 0.3, 0.4, 0.5]);
      }
      return Promise.resolve({});
    }),
    composePrompt: vi.fn().mockReturnValue('Composed prompt'),
    composeState: vi.fn().mockResolvedValue({ values: {}, data: {} }),
    createMemory: vi.fn().mockResolvedValue({ id: 'memory-id' }),
    getRoom: vi
      .fn()
      .mockResolvedValue({
        id: 'room-id',
        name: 'Test Room',
        worldId: 'test-world-id',
        serverId: 'test-server-id',
      }),
    getRooms: vi
      .fn()
      .mockResolvedValue([
        { id: 'room-id', name: 'Test Room', worldId: 'test-world-id', serverId: 'test-server-id' },
      ]),
    getWorld: vi.fn().mockResolvedValue({
      id: 'test-world-id',
      name: 'Test World',
      serverId: 'test-server-id',
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
    addEmbeddingToMemory: vi.fn().mockResolvedValue({
      id: 'memory-id',
      entityId: 'test-entity-id',
      roomId: 'test-room-id',
      content: { text: 'Test fact' },
    }),
    createRelationship: vi.fn().mockResolvedValue(true),
    updateRelationship: vi.fn().mockResolvedValue(true),
    getRelationships: vi.fn().mockResolvedValue([]),
    addRelationship: vi.fn().mockResolvedValue(true),
    getTasks: vi.fn().mockResolvedValue([]),
    getTasksByName: vi.fn().mockResolvedValue([]),
    createTask: vi.fn().mockResolvedValue({ id: 'task-id' }),
    updateTasks: vi.fn().mockResolvedValue([]),
    deleteTasks: vi.fn().mockResolvedValue([]),
    deleteTask: vi.fn().mockResolvedValue(true),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    registerEvent: vi.fn(),
    getCache: vi.fn().mockResolvedValue(null),
    setCache: vi.fn().mockResolvedValue(true),

    // Task-related methods needed for TaskService tests
    registerTaskWorker: vi.fn(),
    getTaskWorker: vi.fn().mockReturnValue({
      name: 'test-worker',
      validate: vi.fn().mockResolvedValue(true),
      execute: vi.fn().mockResolvedValue({}),
    }),
    getParticipantUserState: vi.fn().mockResolvedValue('ACTIVE'),
    setParticipantUserState: vi.fn().mockResolvedValue(undefined),
    updateParticipantUserState: vi.fn().mockResolvedValue(undefined),
    getUserServerRole: vi.fn().mockResolvedValue('USER'),
    findEntityByName: vi.fn().mockResolvedValue(null),
    getMemberRole: vi.fn().mockResolvedValue('USER'),

    // Methods missing in the original implementation
    searchMemories: vi.fn().mockResolvedValue([
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
    getRoomsForParticipants: vi
      .fn()
      .mockResolvedValue([
        { id: 'room-id', name: 'Test Room', worldId: 'test-world-id', serverId: 'test-server-id' },
      ]),
    getRoomsForEntity: vi
      .fn()
      .mockResolvedValue([
        { id: 'room-id', name: 'Test Room', worldId: 'test-world-id', serverId: 'test-server-id' },
      ]),
    searchEntities: vi
      .fn()
      .mockResolvedValue([
        { id: 'test-entity-id', names: ['Test Entity'], worldId: 'test-world-id' },
      ]),
    searchRooms: vi
      .fn()
      .mockResolvedValue([{ id: 'room-id', name: 'Test Room', worldId: 'test-world-id' }]),
    getEntity: vi.fn().mockResolvedValue({
      id: 'test-entity-id',
      names: ['Test Entity'],
      worldId: 'test-world-id',
      serverId: 'test-server-id',
    }),
    getWorldSettings: vi.fn().mockResolvedValue([
      { name: 'setting1', value: 'value1', description: 'Description 1' },
      { name: 'setting2', value: 'value2', description: 'Description 2' },
    ]),
    findWorldsForOwner: vi
      .fn()
      .mockResolvedValue([{ id: 'test-world-id', name: 'Test World', serverId: 'test-server-id' }]),

    // File, PDF, and Image service methods
    uploadFile: vi.fn().mockResolvedValue({ id: 'file-id', name: 'test.txt' }),
    getFile: vi.fn().mockResolvedValue({ id: 'file-id', content: 'Test file content' }),
    listFiles: vi.fn().mockResolvedValue([{ id: 'file-id', name: 'test.txt' }]),
    deleteFile: vi.fn().mockResolvedValue(true),
    extractTextFromPDF: vi.fn().mockResolvedValue('Extracted text from PDF'),
    describeImage: vi.fn().mockResolvedValue('An image description'),

    // Added for recentMessages provider
    getMemoriesByRoomIds: vi.fn().mockResolvedValue([
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
      channelType: 'GROUP',
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
        type: 'group',
        worldId: 'test-world-id',
        serverId: 'test-server-id',
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
    execute: vi.fn().mockResolvedValue({}),
    init: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

/**
 * Type definition for the mock runtime to ensure type safety in tests
 */
export type MockRuntime = Partial<IAgentRuntime & IDatabaseAdapter> & {
  agentId: UUID;
  character: Character;
  providers: Provider[];
  actions: Action[];
  evaluators: Evaluator[];
  plugins: Plugin[];
  services: Map<string, Service>;
  events: Map<string, ((params: any) => Promise<void>)[]>;
  routes: Route[];

  // Additional properties and methods commonly used in tests
  useModel: ReturnType<typeof vi.fn>;
  composePrompt: ReturnType<typeof vi.fn>;
  composeState: ReturnType<typeof vi.fn>;
  createMemory: ReturnType<typeof vi.fn>;
  getRoom: ReturnType<typeof vi.fn>;
  getRooms: ReturnType<typeof vi.fn>;
  getWorld: ReturnType<typeof vi.fn>;
  addEmbeddingToMemory: ReturnType<typeof vi.fn>;
  createRelationship: ReturnType<typeof vi.fn>;
  updateRelationship: ReturnType<typeof vi.fn>;
  getRelationships: ReturnType<typeof vi.fn>;
  addRelationship: ReturnType<typeof vi.fn>;
  getTasks: ReturnType<typeof vi.fn>;
  getTasksByName: ReturnType<typeof vi.fn>;
  createTask: ReturnType<typeof vi.fn>;
  updateTasks: ReturnType<typeof vi.fn>;
  deleteTasks: ReturnType<typeof vi.fn>;
  deleteTask: ReturnType<typeof vi.fn>;
  emitEvent: ReturnType<typeof vi.fn>;
  registerEvent: ReturnType<typeof vi.fn>;
  getCache: ReturnType<typeof vi.fn>;
  setCache: ReturnType<typeof vi.fn>;

  // Task-related methods
  registerTaskWorker: ReturnType<typeof vi.fn>;
  getTaskWorker: ReturnType<typeof vi.fn>;

  // Additional methods used in action tests
  updateParticipantUserState: ReturnType<typeof vi.fn>;
  getUserServerRole: ReturnType<typeof vi.fn>;
  findEntityByName: ReturnType<typeof vi.fn>;
  getParticipantUserState: ReturnType<typeof vi.fn>;
  setParticipantUserState: ReturnType<typeof vi.fn>;
  getMemberRole: ReturnType<typeof vi.fn>;

  // Methods that were missing from the original implementation
  searchMemories: ReturnType<typeof vi.fn>;
  getRoomsForParticipants: ReturnType<typeof vi.fn>;
  getRoomsForEntity: ReturnType<typeof vi.fn>;
  searchEntities: ReturnType<typeof vi.fn>;
  searchRooms: ReturnType<typeof vi.fn>;
  getEntity: ReturnType<typeof vi.fn>;
  getWorldSettings: ReturnType<typeof vi.fn>;
  findWorldsForOwner: ReturnType<typeof vi.fn>;

  // File, PDF, and Image service methods
  uploadFile: ReturnType<typeof vi.fn>;
  getFile: ReturnType<typeof vi.fn>;
  listFiles: ReturnType<typeof vi.fn>;
  deleteFile: ReturnType<typeof vi.fn>;
  extractTextFromPDF: ReturnType<typeof vi.fn>;
  describeImage: ReturnType<typeof vi.fn>;

  // Added for recentMessages provider
  getMemoriesByRoomIds: ReturnType<typeof vi.fn>;
};
