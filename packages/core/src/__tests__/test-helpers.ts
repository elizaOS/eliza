/**
 * Shared test helpers for core package tests.
 */
import { mock } from 'bun:test';
import type { IDatabaseAdapter, UUID } from '../types';
import { stringToUuid } from '../utils';

/**
 * Creates a mock database adapter with all methods mocked.
 * Override specific methods by passing them in the overrides parameter.
 *
 * To access .mock.calls for assertions, cast the method:
 * @example (mockAdapter.createMemory as any).mock.calls[0]
 */
export function createMockAdapter(overrides: Partial<IDatabaseAdapter> = {}): IDatabaseAdapter {
  const defaultMocks = {
    db: {},
    init: mock(async () => {}),
    initialize: mock(async () => {}),
    close: mock(async () => {}),
    isReady: mock(async () => true),
    getConnection: mock(async () => ({})),
    getAgent: mock(async () => ({ id: stringToUuid('test-agent'), name: 'Test Agent' })),
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
    createEntity: mock(async () => true),
    addParticipantsRoom: mock(async () => true),
    createRooms: mock(async () => []),
    createRoom: mock(async () => true),
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
    createMemory: mock(async () => 'memory-id' as UUID),
    updateMemory: mock(async () => true),
    deleteMemory: mock(async () => {}),
    deleteManyMemories: mock(async () => {}),
    deleteAllMemories: mock(async () => {}),
    countMemories: mock(async () => 0),
    createWorld: mock(async () => 'world-id' as UUID),
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
    createTask: mock(async () => 'task-id' as UUID),
    getTasks: mock(async () => []),
    getTask: mock(async () => null),
    getTasksByName: mock(async () => []),
    updateTask: mock(async () => {}),
    deleteTask: mock(async () => {}),
    getMemoriesByWorldId: mock(async () => []),
  };

  return { ...defaultMocks, ...overrides } as unknown as IDatabaseAdapter;
}
