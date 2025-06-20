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
 * Creates a mock runtime for testing
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
      name: 'Test Character',
      bio: 'This is a test character for testing',
    },
    services: new Map(),

    // Core methods
    getService: mock().mockReturnValue(null),
    registerService: mock(),
    getSetting: mock().mockReturnValue(null),

    // Model methods
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

    // Additional methods used in tests
    init: mock().mockResolvedValue(undefined),
    ...overrides,
  };

  // Merge with overrides
  return mockRuntime;
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
      source: 'test',
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
    ...overrides,
    values: {
      recentMessages: 'User: Test message',
      ...overrides.values,
    },
    data: {
      ...overrides.data,
    },
  };
}

/**
 * Creates a standardized setup for testing with consistent mock objects
 *
 * @param overrides - Optional overrides for default mock implementations
 * @returns An object containing mockRuntime, mockMessage, mockState, and callbackFn
 */
export function setupTest(
  overrides: {
    runtimeOverrides?: Partial<MockRuntime>;
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
 * Type definition for the mock runtime
 */
export interface MockRuntime {
  agentId: UUID;
  character: {
    name: string;
    bio: string;
    [key: string]: any;
  };
  services: Map<string, Service>;
  getService: ReturnType<typeof mock>;
  registerService: ReturnType<typeof mock>;
  getSetting: ReturnType<typeof mock>;
  useModel: ReturnType<typeof mock>;
  init: ReturnType<typeof mock>;
  [key: string]: any;
}

// Add spy on logger for common usage in tests
export function setupLoggerSpies() {
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'error').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
  spyOn(logger, 'debug').mockImplementation(() => {});

  // allow tests to restore originals
  return () => mock.restore();
}
