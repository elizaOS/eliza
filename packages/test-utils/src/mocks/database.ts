/**
 * @fileoverview Mock implementations for IDatabaseAdapter and related database interfaces
 *
 * This module provides comprehensive mock implementations for database operations,
 * supporting both unit and integration testing scenarios.
 */

import type { IDatabaseAdapter, UUID } from '@elizaos/core';
import { mock } from './mockUtils';

/**
 * Type representing overrides for IDatabaseAdapter mock creation
 */
export type MockDatabaseOverrides = Partial<IDatabaseAdapter>;

/**
 * Create a comprehensive mock of IDatabaseAdapter with intelligent defaults
 *
 * This function provides a fully-featured database adapter mock that implements
 * all database operations with sensible defaults and proper return types.
 *
 * @param overrides - Partial object to override specific methods or properties
 * @returns Complete mock implementation of IDatabaseAdapter
 *
 * @example
 * ```typescript
 * import { createMockDatabase } from '@elizaos/core/test-utils';
 * import { mock } from 'bun:test';
 *
 * const mockDb = createMockDatabase({
 *   getMemories: mock().mockResolvedValue([mockMemory]),
 *   createMemory: mock().mockResolvedValue('memory-id')
 * });
 * ```
 */
export function createMockDatabase(overrides: MockDatabaseOverrides = {}): IDatabaseAdapter {
  // Mock database connection
  const mockConnection = {
    execute: mock().mockResolvedValue([]),
    query: mock().mockResolvedValue([]),
    run: mock().mockResolvedValue({ changes: 1 }),
    all: mock().mockResolvedValue([]),
    get: mock().mockResolvedValue(null),
  };

  const baseDatabaseAdapter: IDatabaseAdapter = {
    // Core Database Properties
    db: overrides.db || mockConnection,

    // Core Lifecycle Methods
    init: mock().mockResolvedValue(undefined),
    initialize: mock().mockResolvedValue(undefined),
    isReady: mock().mockResolvedValue(true),
    close: mock().mockResolvedValue(undefined),
    getConnection: mock().mockResolvedValue(mockConnection),

    // Agent Management
    getAgent: mock().mockResolvedValue(null),
    getAgents: mock().mockResolvedValue([]),
    createAgent: mock().mockResolvedValue(true),
    updateAgent: mock().mockResolvedValue(true),
    deleteAgent: mock().mockResolvedValue(true),

    // Entity Management
    getEntitiesByIds: mock().mockResolvedValue([]),
    getEntitiesForRoom: mock().mockResolvedValue([]),
    createEntities: mock().mockResolvedValue(true),
    updateEntity: mock().mockResolvedValue(undefined),

    // Component Management
    getComponent: mock().mockResolvedValue(null),
    getComponents: mock().mockResolvedValue([]),
    createComponent: mock().mockResolvedValue(true),
    updateComponent: mock().mockResolvedValue(undefined),
    deleteComponent: mock().mockResolvedValue(undefined),

    // Memory Management
    getMemories: mock().mockResolvedValue([]),
    getMemoryById: mock().mockResolvedValue(null),
    getMemoriesByIds: mock().mockResolvedValue([]),
    getMemoriesByRoomIds: mock().mockResolvedValue([]),
    getMemoriesByWorldId: mock().mockResolvedValue([]),
    getCachedEmbeddings: mock().mockResolvedValue([]),
    searchMemories: mock().mockResolvedValue([]),
    createMemory: mock().mockResolvedValue('test-memory-id' as UUID),
    updateMemory: mock().mockResolvedValue(true),
    deleteMemory: mock().mockResolvedValue(undefined),
    deleteManyMemories: mock().mockResolvedValue(undefined),
    deleteAllMemories: mock().mockResolvedValue(undefined),
    countMemories: mock().mockResolvedValue(0),
    ensureEmbeddingDimension: mock().mockResolvedValue(undefined),

    // Logging
    log: mock().mockResolvedValue(undefined),
    getLogs: mock().mockResolvedValue([]),
    deleteLog: mock().mockResolvedValue(undefined),

    // World Management
    createWorld: mock().mockResolvedValue('test-world-id' as UUID),
    getWorld: mock().mockResolvedValue(null),
    removeWorld: mock().mockResolvedValue(undefined),
    getAllWorlds: mock().mockResolvedValue([]),
    updateWorld: mock().mockResolvedValue(undefined),

    // Room Management
    getRoomsByIds: mock().mockResolvedValue([]),
    createRooms: mock().mockResolvedValue([]),
    deleteRoom: mock().mockResolvedValue(undefined),
    deleteRoomsByWorldId: mock().mockResolvedValue(undefined),
    updateRoom: mock().mockResolvedValue(undefined),
    getRoomsForParticipant: mock().mockResolvedValue([]),
    getRoomsForParticipants: mock().mockResolvedValue([]),
    getRoomsByWorld: mock().mockResolvedValue([]),

    // Participant Management
    removeParticipant: mock().mockResolvedValue(true),
    addParticipantsRoom: mock().mockResolvedValue(true),
    getParticipantsForEntity: mock().mockResolvedValue([]),
    getParticipantsForRoom: mock().mockResolvedValue([]),
    getParticipantUserState: mock().mockResolvedValue(null),
    setParticipantUserState: mock().mockResolvedValue(undefined),

    // Relationship Management
    createRelationship: mock().mockResolvedValue(true),
    updateRelationship: mock().mockResolvedValue(undefined),
    getRelationship: mock().mockResolvedValue(null),
    getRelationships: mock().mockResolvedValue([]),

    // Cache Management
    getCache: mock().mockResolvedValue(undefined),
    setCache: mock().mockResolvedValue(true),
    deleteCache: mock().mockResolvedValue(true),

    // Task Management
    createTask: mock().mockResolvedValue('test-task-id' as UUID),
    getTasks: mock().mockResolvedValue([]),
    getTask: mock().mockResolvedValue(null),
    getTasksByName: mock().mockResolvedValue([]),
    updateTask: mock().mockResolvedValue(undefined),
    deleteTask: mock().mockResolvedValue(undefined),

    // Apply overrides
    ...overrides,
  };

  return baseDatabaseAdapter;
}

/**
 * Create a simple mock database connection object
 *
 * @param overrides - Partial object to override specific methods
 * @returns Mock database connection
 */
export function createMockDbConnection(overrides: any = {}) {
  return {
    execute: mock().mockResolvedValue([]),
    query: mock().mockResolvedValue([]),
    run: mock().mockResolvedValue({ changes: 1 }),
    all: mock().mockResolvedValue([]),
    get: mock().mockResolvedValue(null),
    prepare: mock().mockReturnValue({
      get: mock().mockReturnValue(null),
      all: mock().mockReturnValue([]),
      run: mock().mockReturnValue({ changes: 1 }),
    }),
    ...overrides,
  };
}
