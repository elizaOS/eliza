/**
 * @fileoverview Test Utilities for Forms Plugin Tests
 *
 * This module provides testing utilities that use REAL AgentRuntime instances.
 * NO MOCKS - all tests run against actual runtime infrastructure.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";

/**
 * Creates a test memory object for testing
 */
export function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: `${uuidv4()}` as UUID,
    entityId: `${uuidv4()}` as UUID,
    roomId: `${uuidv4()}` as UUID,
    agentId: `${uuidv4()}` as UUID,
    content: {
      text: "test message",
      source: "test",
    },
    createdAt: Date.now(),
    ...overrides,
  } as Memory;
}

/**
 * Creates a test state object for testing
 */
export function createTestState(overrides: Partial<State> = {}): State {
  return {
    values: {},
    data: {},
    text: "",
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
