/**
 * Test Helper Utilities for Core Package Tests
 *
 * For unit testing pure functions, use standard bun:test assertions.
 * For integration testing, use the testing module from @elizaos/core/testing.
 *
 * This file is being kept for backwards compatibility but new tests
 * should use real integration testing infrastructure instead of mocks.
 */

import { type Mock, mock } from "bun:test";
import type { IDatabaseAdapter, UUID } from "../types";
import { stringToUuid } from "../utils";

/**
 * Type for a mocked function that extends the base function type
 * @deprecated Use real database adapters for integration testing
 */
type MockedFunction<T extends (...args: never[]) => unknown> = Mock<T>;

/**
 * Mock database adapter type with mock call tracking support
 * @deprecated For integration tests, use real database via @elizaos/plugin-sql
 */
export interface MockDatabaseAdapter extends IDatabaseAdapter {
  [K: string]: MockedFunction<(...args: never[]) => unknown> | unknown;
}

/**
 * Creates a mock database adapter with all methods mocked.
 *
 * @deprecated This function creates mocks which should only be used for unit testing
 * pure functions. For integration testing, use real database via @elizaos/plugin-sql:
 *
 * ```typescript
 * import { createTestDatabase } from '@elizaos/plugin-sql/__tests__/test-helpers';
 *
 * const { adapter, runtime, cleanup } = await createTestDatabase(agentId);
 * try {
 *   // Use real adapter
 * } finally {
 *   await cleanup();
 * }
 * ```
 */
export function createMockAdapter(
  overrides: Partial<IDatabaseAdapter> = {},
): MockDatabaseAdapter {
  const defaultMocks: MockDatabaseAdapter = {
    db: {},
    init: mock(async () => {}),
    close: mock(async () => {}),
    isReady: mock(async () => true),
    getConnection: mock(async () => ({})),
    getAgent: mock(async () => ({
      id: stringToUuid("test-agent"),
      name: "Test Agent",
    })),
    getAgents: mock(async () => []),
    createAgent: mock(async () => true),
    updateAgent: mock(async () => true),
    deleteAgent: mock(async () => true),
    ensureEmbeddingDimension: mock(async () => {}),
    log: mock(async () => {}),
    runMigrations: mock(async () => {}),
    runPluginMigrations: mock(async () => {}),
    getEntitiesByIds: mock(async () => []),
    getRoomsByIds: mock(async () => []),
    getParticipantsForRoom: mock(async () => []),
    createEntities: mock(async () => true),
    addParticipantsRoom: mock(async () => true),
    createRooms: mock(async () => []),
    getEntitiesForRoom: mock(async () => []),
    updateEntity: mock(async () => {}),
    getComponent: mock(async () => null),
    getComponents: mock(async () => []),
    createComponent: mock(async () => true),
    updateComponent: mock(async () => {}),
    deleteComponent: mock(async () => {}),
    getMemories: mock(async () => []),
    getMemoryById: mock(async () => null),
    getMemoriesByIds: mock(async () => []),
    getMemoriesByRoomIds: mock(async () => []),
    getCachedEmbeddings: mock(async () => []),
    getLogs: mock(async () => []),
    deleteLog: mock(async () => {}),
    searchMemories: mock(async () => []),
    createMemory: mock(async () => "memory-id" as UUID),
    updateMemory: mock(async () => true),
    deleteMemory: mock(async () => {}),
    deleteManyMemories: mock(async () => {}),
    deleteAllMemories: mock(async () => {}),
    countMemories: mock(async () => 0),
    createWorld: mock(async () => "world-id" as UUID),
    getWorld: mock(async () => null),
    getAllWorlds: mock(async () => []),
    updateWorld: mock(async () => {}),
    removeWorld: mock(async () => {}),
    getRoomsByWorld: mock(async () => []),
    updateRoom: mock(async () => {}),
    deleteRoom: mock(async () => {}),
    deleteRoomsByWorldId: mock(async () => {}),
    getRoomsForParticipant: mock(async () => []),
    getRoomsForParticipants: mock(async () => []),
    removeParticipant: mock(async () => true),
    getParticipantsForEntity: mock(async () => []),
    isRoomParticipant: mock(async () => false),
    getParticipantUserState: mock(async () => null),
    setParticipantUserState: mock(async () => {}),
    createRelationship: mock(async () => true),
    getRelationship: mock(async () => null),
    getRelationships: mock(async () => []),
    updateRelationship: mock(async () => {}),
    getCache: mock(async () => undefined),
    setCache: mock(async () => true),
    deleteCache: mock(async () => true),
    createTask: mock(async () => "task-id" as UUID),
    getTasks: mock(async () => []),
    getTask: mock(async () => null),
    getTasksByName: mock(async () => []),
    updateTask: mock(async () => {}),
    deleteTask: mock(async () => {}),
    getMemoriesByWorldId: mock(async () => []),
  };

  return { ...defaultMocks, ...overrides };
}

// ============================================================================
// RECOMMENDED: Integration Testing Utilities
// ============================================================================

/**
 * Generate a test UUID
 */
export function generateTestUUID(): UUID {
  return stringToUuid(
    `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

/**
 * Wait for a condition to be true
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Measure execution time of an async function
 */
export async function measureTime<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; durationMs: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, durationMs: performance.now() - start };
}
