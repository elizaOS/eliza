import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../src/runtime';
import { MemoryType, ModelType } from '../src/types';
import type {
  Action,
  Agent,
  Character,
  IDatabaseAdapter,
  KnowledgeItem,
  Memory,
  ModelTypeName,
  Plugin,
  Provider,
  State,
  UUID,
} from '../src/types';
import { v4 as uuidv4 } from 'uuid';
const stringToUuid = (id: string): UUID => id as UUID;

// --- Mocks ---

// Use vi.hoisted for prompts mock
const { mockSplitChunks } = vi.hoisted(() => {
  return { mockSplitChunks: vi.fn() };
});
vi.mock('../src/utils', async (importOriginal) => {
  const original = (await importOriginal()) as any;
  return {
    ...original,
    splitChunks: mockSplitChunks,
  };
});

// Use vi.hoisted for ./index mock (safeReplacer)
const { mockSafeReplacer } = vi.hoisted(() => {
  return {
    mockSafeReplacer: vi.fn((key, value) => value), // Simple replacer mock
  };
});
vi.mock('./index', async (importOriginal) => {
  // Mock only safeReplacer, keep others original (if needed)
  // Note: This path might need adjustment based on the actual relative path from the test file to src/index
  // Assuming the test is in __tests__ and index is in src, './index' might not resolve correctly.
  // Let's try '../src/index' relative to the test file.
  const original = (await importOriginal()) as any;
  return {
    ...original,
    safeReplacer: () => mockSafeReplacer, // safeReplacer() is called in the source
  };
});

// Mock IDatabaseAdapter (inline style matching your example)
const mockDatabaseAdapter: IDatabaseAdapter = {
  db: {},
  init: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  getConnection: vi.fn().mockResolvedValue({}),
  getEntityByIds: vi.fn().mockResolvedValue([]),
  createEntities: vi.fn().mockResolvedValue(true),
  getMemories: vi.fn().mockResolvedValue([]),
  getMemoryById: vi.fn().mockResolvedValue(null),
  getMemoriesByRoomIds: vi.fn().mockResolvedValue([]),
  getMemoriesByIds: vi.fn().mockResolvedValue([]),
  getCachedEmbeddings: vi.fn().mockResolvedValue([]),
  log: vi.fn().mockResolvedValue(undefined),
  searchMemories: vi.fn().mockResolvedValue([]),
  createMemory: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
  deleteMemory: vi.fn().mockResolvedValue(undefined),
  deleteAllMemories: vi.fn().mockResolvedValue(undefined),
  countMemories: vi.fn().mockResolvedValue(0),
  getRoomsByIds: vi.fn().mockResolvedValue([]),
  createRooms: vi.fn().mockResolvedValue([stringToUuid(uuidv4())]),
  deleteRoom: vi.fn().mockResolvedValue(undefined),
  getRoomsForParticipant: vi.fn().mockResolvedValue([]),
  getRoomsForParticipants: vi.fn().mockResolvedValue([]),
  addParticipantsRoom: vi.fn().mockResolvedValue(true),
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
  createWorld: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
  getWorld: vi.fn().mockResolvedValue(null),
  getAllWorlds: vi.fn().mockResolvedValue([]),
  updateWorld: vi.fn().mockResolvedValue(undefined),
  updateRoom: vi.fn().mockResolvedValue(undefined),
  getRoomsByWorld: vi.fn().mockResolvedValue([]),
  updateRelationship: vi.fn().mockResolvedValue(undefined),
  getCache: vi.fn().mockResolvedValue(undefined),
  setCache: vi.fn().mockResolvedValue(true),
  deleteCache: vi.fn().mockResolvedValue(true),
  createTask: vi.fn().mockResolvedValue(stringToUuid(uuidv4())),
  getTasks: vi.fn().mockResolvedValue([]),
  getTask: vi.fn().mockResolvedValue(null),
  getTasksByName: vi.fn().mockResolvedValue([]),
  updateTask: vi.fn().mockResolvedValue(undefined),
  deleteTask: vi.fn().mockResolvedValue(undefined),
  updateMemory: vi.fn().mockResolvedValue(true),
  getLogs: vi.fn().mockResolvedValue([]),
  deleteLog: vi.fn().mockResolvedValue(undefined),
  removeWorld: vi.fn().mockResolvedValue(undefined),
};

// Mock action creator (matches your example)
const createMockAction = (name: string): Action => ({
  name,
  description: `Test action ${name}`,
  similes: [`like ${name}`],
  examples: [],
  handler: vi.fn().mockResolvedValue(undefined),
  validate: vi.fn().mockImplementation(async () => true),
});

// Mock Memory creator
const createMockMemory = (
  text: string,
  id?: UUID,
  entityId?: UUID,
  roomId?: UUID,
  agentId?: UUID
): Memory => ({
  id: id ?? stringToUuid(uuidv4()),
  entityId: entityId ?? stringToUuid(uuidv4()),
  agentId: agentId, // Pass agentId if needed
  roomId: roomId ?? stringToUuid(uuidv4()),
  content: { text }, // Assuming simple text content
  createdAt: Date.now(),
  metadata: { type: MemoryType.MESSAGE }, // Simple metadata
});

// Mock State creator
const createMockState = (text = '', values = {}, data = {}): State => ({
  values,
  data,
  text,
});

// Mock Character
const mockCharacter: Character = {
  id: stringToUuid(uuidv4()),
  name: 'Test Character',
  plugins: ['@elizaos/plugin-sql'],
  username: 'test',
  bio: ['Test bio'],
  messageExamples: [], // Ensure required fields are present
  postExamples: [],
  topics: [],
  adjectives: [],
  style: {
    all: [],
    chat: [],
    post: [],
  },
  // Add other fields if your runtime logic depends on them
};

// --- Test Suite ---

describe('AgentRuntime (Non-Instrumented Baseline)', () => {
  let runtime: AgentRuntime;
  let agentId: UUID;

  beforeEach(() => {
    vi.clearAllMocks(); // Vitest equivalent of clearAllMocks
    agentId = mockCharacter.id!; // Use character's ID

    // Instantiate runtime correctly, passing adapter in options object
    runtime = new AgentRuntime({
      character: mockCharacter,
      agentId: agentId,
      adapter: mockDatabaseAdapter, // Correct way to pass adapter
      // No plugins passed here by default, tests can pass them if needed
    });
  });

  it('should construct without errors', () => {
    expect(runtime).toBeInstanceOf(AgentRuntime);
    expect(runtime.agentId).toEqual(agentId);
    expect(runtime.character).toEqual(mockCharacter);
    expect(runtime.adapter).toBe(mockDatabaseAdapter);
  });

  it('should register database adapter via constructor', () => {
    // This is implicitly tested by the constructor test above
    expect(runtime.adapter).toBeDefined();
    expect(runtime.adapter).toEqual(mockDatabaseAdapter);
  });

  describe('Plugin Registration', () => {
    it('should register a simple plugin', async () => {
      const mockPlugin: Plugin = { name: 'TestPlugin', description: 'A test plugin' };
      await runtime.registerPlugin(mockPlugin);
      console.log('runtime.plugins', runtime.plugins);
      // Check if the plugin is added to the internal list
      expect(runtime.plugins.some((p) => p.name === 'TestPlugin')).toBe(true);
    });

    it('should call plugin init function', async () => {
      const initMock = vi.fn().mockResolvedValue(undefined);
      const mockPlugin: Plugin = {
        name: 'InitPlugin',
        description: 'Plugin with init',
        init: initMock,
      };
      await runtime.registerPlugin(mockPlugin);
      expect(initMock).toHaveBeenCalledTimes(1);
      expect(initMock).toHaveBeenCalledWith(expect.anything(), runtime); // Check if called with config and runtime
    });

    it('should register plugin features (actions, providers, models) when initialized', async () => {
      const actionHandler = vi.fn();
      const providerGet = vi.fn().mockResolvedValue({ text: 'provider_text' });
      const modelHandler = vi.fn().mockResolvedValue('model_result');

      const mockPlugin: Plugin = {
        name: 'FeaturesPlugin',
        description: 'Plugin with features',
        actions: [
          {
            name: 'TestAction',
            description: 'Test action',
            handler: actionHandler,
            validate: async () => true,
          },
        ],
        providers: [{ name: 'TestProvider', get: providerGet }],
        models: { [ModelType.TEXT_SMALL]: modelHandler },
      };

      // Re-create runtime passing plugin in constructor
      runtime = new AgentRuntime({
        character: mockCharacter,
        agentId: agentId,
        adapter: mockDatabaseAdapter,
        plugins: [mockPlugin], // Pass plugin during construction
      });

      // Mock adapter calls needed for initialize
      vi.mocked(mockDatabaseAdapter.ensureAgentExists).mockResolvedValue({
        ...mockCharacter,
        id: agentId, // ensureAgentExists should return the agent
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
      });
      vi.mocked(mockDatabaseAdapter.getAgent).mockResolvedValue({
        ...mockCharacter,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
      }); // Add required Agent fields
      vi.mocked(mockDatabaseAdapter.getEntityByIds).mockResolvedValue([
        {
          id: agentId,
          agentId: agentId,
          names: [mockCharacter.name],
        },
      ]);
      vi.mocked(mockDatabaseAdapter.getRoomsByIds).mockResolvedValue([]);
      vi.mocked(mockDatabaseAdapter.getParticipantsForRoom).mockResolvedValue([]);

      await runtime.initialize(); // Initialize to process registrations

      expect(runtime.actions.some((a) => a.name === 'TestAction')).toBe(true);
      expect(runtime.providers.some((p) => p.name === 'TestProvider')).toBe(true);
      expect(runtime.models.has(ModelType.TEXT_SMALL)).toBe(true);
    });
  });

  describe('Initialization', () => {
    beforeEach(() => {
      // Mock adapter calls needed for a successful initialize
      vi.mocked(mockDatabaseAdapter.ensureAgentExists).mockResolvedValue({
        ...mockCharacter,
        id: agentId, // ensureAgentExists should return the agent
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
      });
      vi.mocked(mockDatabaseAdapter.getEntityByIds).mockResolvedValue([
        {
          id: agentId,
          agentId: agentId,
          names: [mockCharacter.name],
        },
      ]);
      vi.mocked(mockDatabaseAdapter.getRoomsByIds).mockResolvedValue([]);
      vi.mocked(mockDatabaseAdapter.getParticipantsForRoom).mockResolvedValue([]);
      // mockDatabaseAdapter.getAgent is NOT called by initialize anymore after ensureAgentExists returns the agent
    });

    it('should call adapter.init and core setup methods', async () => {
      await runtime.initialize();

      expect(mockDatabaseAdapter.init).toHaveBeenCalledTimes(1);
      expect(mockDatabaseAdapter.ensureAgentExists).toHaveBeenCalledWith(mockCharacter);
      // expect(mockDatabaseAdapter.getAgent).toHaveBeenCalledWith(agentId); // This is no longer called
      expect(mockDatabaseAdapter.getEntityByIds).toHaveBeenCalledWith([agentId]);
      expect(mockDatabaseAdapter.getRoomsByIds).toHaveBeenCalledWith([agentId]);
      expect(mockDatabaseAdapter.createRooms).toHaveBeenCalled();
      expect(mockDatabaseAdapter.addParticipantsRoom).toHaveBeenCalledWith([agentId], agentId);
    });

    it('should throw if adapter is not available during initialize', async () => {
      // Create runtime without passing adapter
      const runtimeWithoutAdapter = new AgentRuntime({
        character: mockCharacter,
        agentId: agentId,
      });
      await expect(runtimeWithoutAdapter.initialize()).rejects.toThrow(
        /Database adapter not initialized/
      );
    });

    // Add more tests for initialize: existing entity, existing room, knowledge processing etc.
  });

  describe('State Composition', () => {
    it('should call provider get methods', async () => {
      const provider1Get = vi.fn().mockResolvedValue({ text: 'p1_text', values: { p1_val: 1 } });
      const provider2Get = vi.fn().mockResolvedValue({ text: 'p2_text', values: { p2_val: 2 } });
      const provider1: Provider = { name: 'P1', get: provider1Get };
      const provider2: Provider = { name: 'P2', get: provider2Get };

      runtime.registerProvider(provider1);
      runtime.registerProvider(provider2);

      const message = createMockMemory('test message', undefined, undefined, undefined, agentId);
      const state = await runtime.composeState(message);

      expect(provider1Get).toHaveBeenCalledTimes(1);
      // The cached state passed will be the initial empty-ish one
      expect(provider1Get).toHaveBeenCalledWith(runtime, message, {
        values: {},
        data: {},
        text: '',
      });
      expect(provider2Get).toHaveBeenCalledTimes(1);
      expect(provider2Get).toHaveBeenCalledWith(runtime, message, {
        values: {},
        data: {},
        text: '',
      });
      expect(state.text).toContain('p1_text');
      expect(state.text).toContain('p2_text');
      expect(state.values).toHaveProperty('p1_val', 1);
      expect(state.values).toHaveProperty('p2_val', 2);
      // Check combined values includes provider outputs
      expect(state.values).toHaveProperty('providers'); // Check if the combined text is stored
      expect(state.data.providers.P1.values).toEqual({ p1_val: 1 }); // Check provider data cache
      expect(state.data.providers.P2.values).toEqual({ p2_val: 2 });
    });

    it('should filter providers', async () => {
      const provider1Get = vi.fn().mockResolvedValue({ text: 'p1_text' });
      const provider2Get = vi.fn().mockResolvedValue({ text: 'p2_text' });
      const provider1: Provider = { name: 'P1', get: provider1Get };
      const provider2: Provider = { name: 'P2', get: provider2Get };

      runtime.registerProvider(provider1);
      runtime.registerProvider(provider2);

      const message = createMockMemory('test message', undefined, undefined, undefined, agentId);
      const state = await runtime.composeState(message, ['P1'], true); // Filter to only P1

      expect(provider1Get).toHaveBeenCalledTimes(1);
      expect(provider2Get).not.toHaveBeenCalled();
      expect(state.text).toBe('p1_text');
    });

    // Add tests for includeList, caching behavior
  });

  describe('Model Usage', () => {
    it('should call registered model handler', async () => {
      const modelHandler = vi.fn().mockResolvedValue({ result: 'success' });
      const modelType = ModelType.TEXT_LARGE;

      runtime.registerModel(modelType, modelHandler, 'test-provider');

      const params = { prompt: 'test prompt', someOption: true };
      const result = await runtime.useModel(modelType, params);

      expect(modelHandler).toHaveBeenCalledTimes(1);
      // Check that handler was called with runtime and merged params
      expect(modelHandler).toHaveBeenCalledWith(
        runtime,
        expect.objectContaining({ ...params, runtime: runtime })
      );
      expect(result).toEqual({ result: 'success' });
      // Check if log was called (part of useModel logic)
      expect(mockDatabaseAdapter.log).toHaveBeenCalledWith(
        expect.objectContaining({ type: `useModel:${modelType}` })
      );
    });

    it('should throw if model type is not registered', async () => {
      const modelType = 'UNREGISTERED_MODEL' as ModelTypeName;
      const params = { prompt: 'test' };
      await expect(runtime.useModel(modelType, params)).rejects.toThrow(/No handler found/);
    });
  });

  describe('Action Processing', () => {
    let mockActionHandler: any; // Use 'any' or specific function type
    let testAction: Action;
    let message: Memory;
    let responseMemory: Memory;

    beforeEach(() => {
      mockActionHandler = vi.fn().mockResolvedValue(undefined);
      testAction = createMockAction('TestAction');
      testAction.handler = mockActionHandler; // Assign mock handler

      runtime.registerAction(testAction);

      message = createMockMemory('user message', undefined, undefined, undefined, agentId);
      responseMemory = createMockMemory(
        'agent response',
        undefined,
        undefined,
        message.roomId,
        agentId
      ); // Same room
      responseMemory.content.actions = ['TestAction']; // Specify action to run

      // Mock composeState as it's called within processActions
      vi.spyOn(runtime, 'composeState').mockResolvedValue(createMockState('composed state text'));
    });

    it('should find and execute the correct action handler', async () => {
      await runtime.processActions(message, [responseMemory]);

      expect(runtime.composeState).toHaveBeenCalled(); // Verify state was composed
      expect(mockActionHandler).toHaveBeenCalledTimes(1);
      // Check arguments passed to the handler
      expect(mockActionHandler).toHaveBeenCalledWith(
        runtime,
        message,
        expect.objectContaining({ text: 'composed state text' }), // Check composed state
        {}, // options
        undefined, // callback
        [responseMemory] // responses array
      );
      expect(mockDatabaseAdapter.log).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'action',
          body: expect.objectContaining({ action: 'TestAction' }),
        })
      );
    });

    // Add tests for action not found, simile matching, handler errors
    it('should not execute if no action name matches', async () => {
      responseMemory.content.actions = ['NonExistentAction'];
      await runtime.processActions(message, [responseMemory]);
      expect(mockActionHandler).not.toHaveBeenCalled();
      expect(mockDatabaseAdapter.log).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'action' })
      );
    });
  });

  // --- Adapter Passthrough Tests ---
  describe('Adapter Passthrough', () => {
    it('createEntity should call adapter.createEntities', async () => {
      const entityData = { id: stringToUuid(uuidv4()), agentId: agentId, names: ['Test Entity'] };
      await runtime.createEntity(entityData);
      expect(mockDatabaseAdapter.createEntities).toHaveBeenCalledTimes(1);
      expect(mockDatabaseAdapter.createEntities).toHaveBeenCalledWith([entityData]);
    });

    it('getMemoryById should call adapter.getMemoryById', async () => {
      const memoryId = stringToUuid(uuidv4());
      await runtime.getMemoryById(memoryId);
      expect(mockDatabaseAdapter.getMemoryById).toHaveBeenCalledTimes(1);
      expect(mockDatabaseAdapter.getMemoryById).toHaveBeenCalledWith(memoryId);
    });
    // Add more tests for other adapter methods if full coverage is desired
  });

  // --- Event Emitter Tests ---
  describe('Event Emitter (on/emit/off)', () => {
    it('should register and emit events', () => {
      const handler = vi.fn();
      const eventName = 'testEvent';
      const eventData = { info: 'data' };

      runtime.on(eventName, handler);
      runtime.emit(eventName, eventData);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(eventData);
    });

    it('should remove event handler with off', () => {
      const handler = vi.fn();
      const eventName = 'testEvent';

      runtime.on(eventName, handler);
      runtime.off(eventName, handler);
      runtime.emit(eventName, { info: 'data' });

      expect(handler).not.toHaveBeenCalled();
    });
  });

  // --- Tests from original suite ---
  describe('Original Suite Tests', () => {
    // Note: These might need slight adaptation if they relied on Jest specifics
    // or different mock setups.

    // Copied from your original suite:
    describe('model provider management', () => {
      it('should provide access to the configured model provider', () => {
        // In this refactored structure, 'provider' likely refers to the runtime instance itself
        // which acts as the primary interface.
        const provider = runtime; // The runtime instance manages models
        expect(provider).toBeDefined();
        // You might add more specific checks here, e.g., ensuring getModel exists
        expect(runtime.getModel).toBeInstanceOf(Function);
      });
    });

    // Copied from your original suite:
    describe('state management', () => {
      it('should compose state with additional keys', async () => {
        // Use the helper function for consistency
        const message: Memory = createMockMemory(
          'test message',
          stringToUuid('11111111-e89b-12d3-a456-426614174003'), // Use valid UUIDs
          stringToUuid('22222222-e89b-12d3-a456-426614174004'),
          stringToUuid('33333333-e89b-12d3-a456-426614174003'), // Room ID
          agentId
        );

        // Mock provider needed by composeState
        const providerGet = vi.fn().mockResolvedValue({ text: 'provider text' });
        runtime.registerProvider({ name: 'TestProvider', get: providerGet });

        const state = await runtime.composeState(message);
        expect(state).toHaveProperty('values');
        expect(state).toHaveProperty('text');
        expect(state).toHaveProperty('data');
        // Add more specific state checks if needed
        expect(state.text).toContain('provider text'); // Check provider text is included
      });
    });

    // Copied from your original suite:
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
}); // End of main describe block
