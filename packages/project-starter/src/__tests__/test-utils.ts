import { mock, spyOn } from 'bun:test';
import { Content, IAgentRuntime, Memory, State, logger } from '@elizaos/core';
import {
  createMockRuntime as createCoreMockRuntime,
  createMockMessage as createCoreMockMessage,
  createMockState as createCoreMockState,
  documentTestResult,
  runCoreActionTests,
} from './utils/core-test-utils';
import { character } from '../index';
import plugin from '../plugin';

/**
 * Creates an enhanced mock runtime for testing that includes the project's
 * character and plugin
 *
 * @param overrides - Optional overrides for the default mock methods and properties
 * @returns A mock runtime for testing
 */
export function createMockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  // Create base mock runtime with default core utilities
  const baseRuntime = createCoreMockRuntime();

  // Enhance with project-specific configuration
  const mockRuntime = {
    ...baseRuntime,
    character: character,
    plugins: [plugin],
    registerPlugin: mock(),
    initialize: mock(),
    getService: mock(),
    getSetting: mock().mockReturnValue(null),
    useModel: mock().mockResolvedValue('Test model response'),
    getProviderResults: mock().mockResolvedValue([]),
    evaluateProviders: mock().mockResolvedValue([]),
    evaluate: mock().mockResolvedValue([]),
    ...overrides,
  } as unknown as IAgentRuntime;

  return mockRuntime;
}

/**
 * Creates a mock Message object for testing
 *
 * @param text - The message text
 * @param overrides - Optional overrides for the default memory properties
 * @returns A mock memory object
 */
export function createMockMessage(text: string, overrides: Partial<Memory> = {}): Memory {
  const baseMessage = createCoreMockMessage(text);
  return {
    ...baseMessage,
    ...overrides,
  };
}

/**
 * Creates a mock State object for testing
 *
 * @param overrides - Optional overrides for the default state properties
 * @returns A mock state object
 */
export function createMockState(overrides: Partial<State> = {}): State {
  const baseState = createCoreMockState();
  return {
    ...baseState,
    ...overrides,
  };
}

/**
 * Creates a standardized setup for testing with consistent mock objects
 *
 * @param overrides - Optional overrides for default mock implementations
 * @returns An object containing mockRuntime, mockMessage, mockState, and callbackFn
 */
export function setupTest(
  options: {
    messageText?: string;
    messageOverrides?: Partial<Memory>;
    runtimeOverrides?: Partial<IAgentRuntime>;
    stateOverrides?: Partial<State>;
  } = {}
) {
  // Create mock callback function
  const callbackFn = mock();

  // Create a message
  const mockMessage = createMockMessage(
    options.messageText || 'Test message',
    options.messageOverrides || {}
  );

  // Create a state object
  const mockState = createMockState(options.stateOverrides || {});

  // Create a mock runtime
  const mockRuntime = createMockRuntime(options.runtimeOverrides || {});

  return {
    mockRuntime,
    mockMessage,
    mockState,
    callbackFn,
  };
}

// Export other utility functions
export { documentTestResult, runCoreActionTests };

// Add spy on logger for common usage in tests
export function setupLoggerSpies() {
  spyOn(logger, 'info').mockImplementation(() => {});
  spyOn(logger, 'error').mockImplementation(() => {});
  spyOn(logger, 'warn').mockImplementation(() => {});
  spyOn(logger, 'debug').mockImplementation(() => {});

  // allow tests to restore originals
  return () => mock.restore();
}
