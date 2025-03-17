import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/runtime';
import type { Action, IDatabaseAdapter, Memory, UUID } from '../src/types';

// Mock dependencies with minimal implementations
/**
 * Mock database adapter for testing purposes.
 * @type {IDatabaseAdapter}
 */
const mockDatabaseAdapter: IDatabaseAdapter = {
  db: {},
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getEntityById: vi.fn().mockResolvedValue(null),
  createEntity: vi.fn().mockResolvedValue(true),
  getMemories: vi.fn().mockResolvedValue([]),
  getMemoryById: vi.fn().mockResolvedValue(null),
  getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
  getMemoriesByIds: vi.fn().mockResolvedValue([]),
  getCachedEmbeddings: vi.fn().mockResolvedValue([]),
  log: vi.fn().mockResolvedValue(undefined),
  searchMemories: vi.fn().mockResolvedValue([]),
  createMemory: vi.fn().mockResolvedValue(undefined),
  deleteMemory: vi.fn().mockResolvedValue(undefined),
  deleteAllMemories: vi.fn().mockResolvedValue(undefined),
  countMemories: vi.fn().mockResolvedValue(0),
  getRoom: vi.fn().mockResolvedValue(null),
  createRoom: vi.fn().mockResolvedValue('test-room-id' as UUID),
  deleteRoom: vi.fn().mockResolvedValue(undefined),
  getRoomsForParticipant: vi.fn().mockResolvedValue([]),
  getRoomsForParticipants: vi.fn().mockResolvedValue([]),
  addParticipant: vi.fn().mockResolvedValue(true),
  removeParticipant: vi.fn().mockResolvedValue(true),
  getParticipantsForEntity: vi.fn().mockResolvedValue([]),
  getParticipantsForRoom: vi.fn().mockResolvedValue([]),
  getParticipantUserState: vi.fn().mockResolvedValue(null),
  setParticipantUserState: vi.fn().mockResolvedValue(undefined),
  createRelationship: vi.fn().mockResolvedValue(true),
  getRelationship: vi.fn().mockResolvedValue(null),
  getRelationships: vi.fn().mockResolvedValue([]),
  getAgent: vi.fn().mockResolvedValue(null),
  getAgents: vi.fn().mockResolvedValue([]),
  createAgent: vi.fn().mockResolvedValue(true),
  updateAgent: vi.fn().mockResolvedValue(true),
  deleteAgent: vi.fn().mockResolvedValue(true),
  ensureAgentExists: vi.fn().mockResolvedValue(undefined),
  ensureEmbeddingDimension: vi.fn().mockResolvedValue(undefined),
  getEntitiesForRoom: vi.fn().mockResolvedValue([]),
  updateEntity: vi.fn().mockResolvedValue(undefined),
  getComponent: vi.fn().mockResolvedValue(null),
  getComponents: vi.fn().mockResolvedValue([]),
  createComponent: vi.fn().mockResolvedValue(true),
  updateComponent: vi.fn().mockResolvedValue(undefined),
  deleteComponent: vi.fn().mockResolvedValue(undefined),
  createWorld: vi.fn().mockResolvedValue('test-world-id' as UUID),
  getWorld: vi.fn().mockResolvedValue(null),
  getAllWorlds: vi.fn().mockResolvedValue([]),
  updateWorld: vi.fn().mockResolvedValue(undefined),
  updateRoom: vi.fn().mockResolvedValue(undefined),
  getRooms: vi.fn().mockResolvedValue([]),
  updateRelationship: vi.fn().mockResolvedValue(undefined),
  getCache: vi.fn().mockResolvedValue(undefined),
  setCache: vi.fn().mockResolvedValue(true),
  deleteCache: vi.fn().mockResolvedValue(true),
  createTask: vi.fn().mockResolvedValue('test-task-id' as UUID),
  getTasks: vi.fn().mockResolvedValue([]),
  getTask: vi.fn().mockResolvedValue(null),
  getTasksByName: vi.fn().mockResolvedValue([]),
  updateTask: vi.fn().mockResolvedValue(undefined),
  deleteTask: vi.fn().mockResolvedValue(undefined),
};

// Mock action creator
const createMockAction = (name: string): Action => ({
  name,
  description: `Test action ${name}`,
  similes: [`like ${name}`],
  examples: [],
  handler: vi.fn().mockResolvedValue(undefined),
  validate: vi.fn().mockImplementation(async () => true),
});

describe('AgentRuntime', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();

    runtime = new AgentRuntime({
      character: {
        name: 'Test Character',
        username: 'test',
        bio: ['Test bio'],
        messageExamples: [],
        postExamples: [],
        topics: [],
        adjectives: [],
        style: {
          all: [],
          chat: [],
          post: [],
        },
      },
      ...mockDatabaseAdapter,
    });
  });

  describe('model provider management', () => {
    it('should provide access to the configured model provider', () => {
      const provider = runtime;
      expect(provider).toBeDefined();
    });
  });

  describe('state management', () => {
    it('should compose state with additional keys', async () => {
      const message: Memory = {
        id: '123e4567-e89b-12d3-a456-426614174003',
        entityId: '123e4567-e89b-12d3-a456-426614174004',
        agentId: '123e4567-e89b-12d3-a456-426614174005',
        roomId: '123e4567-e89b-12d3-a456-426614174003',
        content: { type: 'text', text: 'test message' },
      };

      const state = await runtime.composeState(message);
      expect(state).toHaveProperty('values');
      expect(state).toHaveProperty('text');
      expect(state).toHaveProperty('data');
    });
  });

  describe('action management', () => {
    it('should register an action', () => {
      const action = createMockAction('testAction');
      runtime.registerAction(action);
      expect(runtime.actions).toContain(action);
    });

    it('should allow registering multiple actions', () => {
      const action1 = createMockAction('testAction1');
      const action2 = createMockAction('testAction2');
      runtime.registerAction(action1);
      runtime.registerAction(action2);
      expect(runtime.actions).toContain(action1);
      expect(runtime.actions).toContain(action2);
    });
  });
});
