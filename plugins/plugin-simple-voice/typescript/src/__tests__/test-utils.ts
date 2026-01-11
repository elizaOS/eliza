/**
 * @fileoverview Test Utilities for Simple Voice Plugin Tests
 *
 * This module provides testing utilities that use REAL AgentRuntime instances.
 * NO MOCKS - all tests run against actual runtime infrastructure.
 */

import { type IAgentRuntime, logger, type Memory, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { vi } from "vitest";

/**
 * Creates a UUID for testing
 */
export function createUUID(): UUID {
  return uuidv4() as UUID;
}

/**
 * Set up logger spies
 */
export function setupLoggerSpies(): void {
  vi.spyOn(logger, "info");
  vi.spyOn(logger, "error");
  vi.spyOn(logger, "warn");
  vi.spyOn(logger, "debug");
}

/**
 * Create a test memory
 */
export function createTestMemory(text: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id: createUUID(),
    entityId: createUUID(),
    agentId: createUUID(),
    roomId: createUUID(),
    content: { text },
    createdAt: Date.now(),
    ...overrides,
  };
}
