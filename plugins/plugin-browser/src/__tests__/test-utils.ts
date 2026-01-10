import { mock, spyOn } from 'bun:test';
import {
  Content,
  IAgentRuntime,
  Memory,
  ModelType,
  Service,
  State,
  UUID,
  logger,
} from '@elizaos/core';

/**
 * Creates a mock runtime for testing stagehand components
 * Implements the mock runtime locally instead of importing from core
 *
 * @param overrides - Optional overrides for the default mock methods and properties
 * @returns A mock runtime for testing
 */
export function createMockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  // Create a comprehensive mock runtime with stagehand-specific defaults
  const mockRuntime = {
    agentId: 'test-agent-id' as UUID,
    character: {
      name: 'Stagehand Test Character',
      bio: ['This is a test character for testing stagehand functionality'],
      system: 'You are a test agent for stagehand automation',
      messageExamples: [],
      postExamples: [],
      topics: ['web-automation', 'testing'],
      knowledge: [],
      plugins: ['@elizaos/plugin-stagehand'],
    },

    // Model methods with stagehand-specific responses
    useModel: mock().mockImplementation((modelType, params) => {
      if (modelType === ModelType.TEXT_SMALL) {
        return Promise.resolve('Never gonna give you up, never gonna let you down');
      } else if (modelType === ModelType.TEXT_LARGE) {
        return Promise.resolve('Never gonna make you cry, never gonna say goodbye');
      } else if (modelType === ModelType.OBJECT_LARGE) {
        return Promise.resolve({
          thought: 'I should respond in a friendly way',
          message: 'Hello there! How can I help you today?',
        });
      }
      return Promise.resolve('Default response');
    }),

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
    getSetting: mock().mockImplementation((key: string) => {
      if (key === 'ENABLE_BROWSER' || key === 'BROWSER_ENABLED') {
        return 'true';
      }
      return null;
    }),
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
    getMemories: mock().mockResolvedValue([]),
    searchMemories: mock().mockResolvedValue([]),
    createMemory: mock().mockResolvedValue(undefined),
    getWorld: mock().mockResolvedValue(null),
    getWorlds: mock().mockResolvedValue([]),
    createWorld: mock().mockResolvedValue(true),
    updateWorld: mock().mockResolvedValue(undefined),
    deleteWorld: mock().mockResolvedValue(undefined),
    getRoom: mock().mockResolvedValue(null),
    getRooms: mock().mockResolvedValue([]),
    createRoom: mock().mockResolvedValue(true),
    updateRoom: mock().mockResolvedValue(undefined),
    deleteRoom: mock().mockResolvedValue(undefined),
    getRelationships: mock().mockResolvedValue([]),
    createRelationships: mock().mockResolvedValue([]),
    deleteRelationships: mock().mockResolvedValue(undefined),
    getParticipants: mock().mockResolvedValue([]),
    setParticipantActive: mock().mockResolvedValue(undefined),

    // Empty arrays/objects for other properties
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [],
    services: new Map(),
    events: new Map(),
    routes: [],

    ...overrides,
  } as unknown as IAgentRuntime;

  return mockRuntime;
}

/**
 * Creates a mock memory for stagehand tests
 * Implements the mock locally instead of importing from core
 */
export function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'test-memory-id' as UUID,
    agentId: 'test-agent-id' as UUID,
    entityId: 'test-entity-id' as UUID,
    roomId: 'test-room-id' as UUID,
    content: {
      text: 'Test message for stagehand automation',
      source: 'stagehand-test',
    },
    createdAt: new Date(),
    ...overrides,
  } as Memory;
}

/**
 * Creates a mock state for stagehand tests
 * Implements the mock locally instead of importing from core
 */
export function createMockState(overrides: Partial<State> = {}): State {
  return {
    values: {
      testValue: 'stagehand test value',
    },
    text: 'Stagehand test context',
    ...overrides,
  } as State;
}

/**
 * Creates a standardized setup for testing with consistent mock objects
 *
 * @param overrides - Optional overrides for default mock implementations
 * @returns An object containing mockRuntime, mockMessage, mockState, and callbackFn
 */
export function setupTest(
  overrides: {
    runtimeOverrides?: Partial<IAgentRuntime>;
    messageOverrides?: Partial<Memory>;
    stateOverrides?: Partial<State>;
  } = {}
) {
  // Create mock callback function
  const callbackFn = mock();

  // Create a message
  const mockMessage = createMockMemory(overrides.messageOverrides);

  // Create a state object
  const mockState = createMockState(overrides.stateOverrides);

  // Create a mock runtime
  const mockRuntime = createMockRuntime({
    ...overrides.runtimeOverrides,
  });

  return {
    mockRuntime,
    mockMessage,
    mockState,
    callbackFn,
  };
}

/**
 * Stagehand-specific test helper functions
 */
export const createMockService = (overrides: Partial<Service> = {}): Service => {
  const mockService = {
    start: mock().mockResolvedValue(undefined),
    stop: mock().mockResolvedValue(undefined),
    getCapabilities: mock().mockReturnValue([]),
    ...overrides,
  } as unknown as Service;

  return mockService;
};

export const createMockContent = (overrides: Partial<Content> = {}): Content => {
  return {
    text: 'Test content for stagehand',
    source: 'stagehand-test',
    ...overrides,
  };
};

// Add spy on logger for common usage in tests
export function setupLoggerSpies() {
  // Import spyOn from bun:test if not already imported
  const { spyOn } = require('bun:test');

  // Use spyOn correctly - it returns a spy object, not a mock
  const infoSpy = spyOn(logger, 'info');
  const errorSpy = spyOn(logger, 'error');
  const warnSpy = spyOn(logger, 'warn');
  const debugSpy = spyOn(logger, 'debug');

  // allow tests to restore originals
  return () => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  };
}
