import type { IAgentRuntime, Memory, State } from '@elizaos/core';
import { v4 as uuidv4 } from 'uuid';

/**
 * Creates a mock memory object for testing
 */
export function createMockMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `memory-${uuidv4()}` as `${string}-${string}-${string}-${string}-${string}`,
    entityId: `entity-${uuidv4()}` as `${string}-${string}-${string}-${string}-${string}`,
    roomId: `room-${uuidv4()}` as `${string}-${string}-${string}-${string}-${string}`,
    agentId: `agent-${uuidv4()}` as `${string}-${string}-${string}-${string}-${string}`,
    content: {
      text: 'test message',
      source: 'test',
    },
    createdAt: Date.now(),
    ...overrides,
  } as Memory;
}

/**
 * Creates a mock state object for testing
 */
export function createMockState(overrides: Partial<State> = {}): State {
  return {
    values: {},
    data: {},
    text: '',
    ...overrides,
  } as State;
}

/**
 * Sets up logger spies for common usage in tests
 */
export function setupLoggerSpies(mockFn?: typeof console.info) {
  const originalConsole = {
    info: console.info,
    error: console.error,
    warn: console.warn,
    debug: console.debug,
  };

  if (mockFn) {
    console.info = mockFn;
    console.error = mockFn;
    console.warn = mockFn;
    console.debug = mockFn;
  }

  // Allow tests to restore originals
  return () => {
    console.info = originalConsole.info;
    console.error = originalConsole.error;
    console.warn = originalConsole.warn;
    console.debug = originalConsole.debug;
  };
}

// Legacy export for compatibility
export type MockRuntime = IAgentRuntime;
