import type { IAgentRuntime, Memory, Service, ServiceTypeName, State } from '@elizaos/core';
import { MockNgrokService } from './mocks/NgrokServiceMock';

type MockRuntimeOverrides = Partial<IAgentRuntime> & {
  settings?: Record<string, string>;
  services?: Record<string, Service | null | undefined>;
};

// Local mock implementations until core test-utils build issue is resolved
const createCoreMockRuntime = (overrides: MockRuntimeOverrides = {}) => ({
  agentId: 'test-agent-id',
  character: { name: 'TestAgent', bio: ['Test agent'], ...overrides.character },
  getSetting: overrides.getSetting || (() => null),
  getService: overrides.getService || (() => null),
  useModel: overrides.useModel || (() => Promise.resolve('{}')),
  composeState: overrides.composeState || (() => Promise.resolve({})),
  getMemories: overrides.getMemories || (() => Promise.resolve([])),
  createMemory: overrides.createMemory || (() => Promise.resolve()),
  ...overrides,
});

const createCoreMockMemory = (overrides: Partial<Memory> = {}) => ({
  id: 'test-memory-id',
  entityId: 'test-entity-id',
  roomId: 'test-room-id',
  content: { text: 'test message' },
  createdAt: Date.now(),
  ...overrides,
});

const createCoreMockState = (overrides: Partial<State> = {}) => ({
  text: 'test state',
  ...overrides,
});

/**
 * Creates a mock runtime for testing ngrok plugin
 * Uses the unified mock runtime from core with ngrok-specific overrides
 *
 * @param overrides - Optional overrides for the default mock methods and properties
 * @returns A mock runtime for testing
 */
export function createMockRuntime(overrides: MockRuntimeOverrides = {}): IAgentRuntime {
  const {
    settings: extraSettings = {},
    services: extraServices = {},
    ...runtimeOverrides
  } = overrides;

  // Use the unified mock runtime from core with ngrok-specific overrides
  return createCoreMockRuntime({
    character: {
      name: 'NgrokTestAgent',
      bio: ['Test agent for ngrok tunnel functionality'],
      system: 'You are a test agent for ngrok tunnel management',
      messageExamples: [],
      postExamples: [],
      topics: ['ngrok', 'tunneling', 'webhooks'],
      knowledge: [],
      plugins: ['@elizaos/plugin-ngrok'],
      ...runtimeOverrides.character,
    },

    // Ngrok-specific settings
    getSetting: (key: string): string | boolean | number | null => {
      const settings: Record<string, string> = {
        NGROK_AUTH_TOKEN: process.env.NGROK_AUTH_TOKEN || 'test-ngrok-auth-token',
        NGROK_DOMAIN: process.env.NGROK_DOMAIN || '',
        NGROK_REGION: 'us',
        LOG_LEVEL: 'info',
        ...extraSettings,
      };
      const direct = settings[key];
      if (direct !== undefined) return direct;
      const envVal = process.env[key];
      return envVal === undefined ? null : envVal;
    },

    // Ngrok-specific services
    getService: <T extends Service>(name: ServiceTypeName | string): T | null => {
      const placeholderRuntime = { agentId: 'mock' } as IAgentRuntime;
      const defaults: Record<string, Service> = {
        'ngrok-tunnel': new MockNgrokService(placeholderRuntime),
      };
      const merged: Record<string, Service | null | undefined> = {
        ...defaults,
        ...extraServices,
      };
      const resolved = merged[String(name)];
      return (resolved ?? null) as T | null;
    },

    ...runtimeOverrides,
  }) as IAgentRuntime;
}

/**
 * Creates a mock Memory object for testing
 * Uses the unified mock with ngrok-specific defaults
 */
export function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  return createCoreMockMemory({
    content: {
      text: 'Ngrok tunnel test message',
      source: 'ngrok-test',
    },
    ...overrides,
  }) as Memory;
}

/**
 * Creates a mock State object for testing
 * Uses the unified mock with ngrok-specific defaults
 */
export function createMockState(overrides: Partial<State> = {}): State {
  return createCoreMockState({
    values: {
      ngrokTunnelActive: false,
      ngrokUrl: null,
    },
    text: 'Ngrok tunnel context',
    ...overrides,
  }) as State;
}

/**
 * Sets up logger spies for common usage in tests
 */
type ConsoleMockFactory = (
  implementation: (...args: unknown[]) => void
) => (...args: unknown[]) => void;

export function setupLoggerSpies(mockFn?: ConsoleMockFactory) {
  const originalConsole = {
    info: console.info,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
  };

  if (mockFn) {
    console.info = mockFn(() => {});
    console.error = mockFn(() => {});
    console.warn = mockFn(() => {});
    console.debug = mockFn(() => {});
  }

  // Allow tests to restore originals
  return () => {
    console.info = originalConsole.info;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.debug = originalConsole.debug;
  };
}
