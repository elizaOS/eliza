import { mock, spyOn } from 'bun:test';
import { Content, IAgentRuntime, Memory, State, logger } from '@elizaos/core';
import {
  createMockRuntime as baseMockRuntime,
  createMockMemory as baseMockMemory,
  createMockState as baseMockState,
} from '@elizaos/core/test-utils';
import {
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
  // Use the centralized mock runtime with project-specific configuration
  return baseMockRuntime({
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
  });
}

/**
 * Creates a mock Message object for testing
 *
 * @param text - The message text
 * @param overrides - Optional overrides for the default memory properties
 * @returns A mock memory object
 */
export function createMockMessage(text: string, overrides: Partial<Memory> = {}): Memory {
  return baseMockMemory({
    content: {
      text,
      source: 'project-starter-test',
    },
    ...overrides,
  });
}

/**
 * Creates a mock State object for testing
 *
 * @param overrides - Optional overrides for the default state properties
 * @returns A mock state object
 */
export function createMockState(overrides: Partial<State> = {}): State {
  return baseMockState({
    values: {
      projectType: 'starter-project',
    },
    text: 'Project starter test context',
    ...overrides,
  });
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
