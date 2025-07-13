import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { AgentRuntime } from '../runtime';
import { AgentRuntime as CoreAgentRuntime } from '../../../runtime';
import { MemoryType, ModelType } from '../types';
import type {
  Action,
  Character,
  IDatabaseAdapter,
  Memory,
  ModelTypeName,
  Plugin,
  Provider,
  State,
  UUID,
} from '../types';
import { v4 as uuidv4 } from 'uuid';
const stringToUuid = (id: string): UUID => id as UUID;

// --- Mocks ---

// Create mock functions
const mockSplitChunks = mock();
const mockSafeReplacer = mock((_key, value) => value);

// Mock modules using bun:test
mock.module('../utils', () => ({
  splitChunks: mockSplitChunks,
}));

mock.module('./index', () => ({
  safeReplacer: () => mockSafeReplacer,
}));

// Mock IDatabaseAdapter (inline style matching your example)
const mockDatabaseAdapter: IDatabaseAdapter = {
  db: {},
  init: mock(async () => undefined),
  close: mock(async () => undefined),
  getConnection: mock(async () => ({})),
  getEntityByIds: mock(async () => []),
  getEntitiesByIds: mock(async () => []),
  createEntities: mock(async () => true),
  getMemories: mock(async () => []),
  getMemoryById: mock(async () => null),
  getMemoriesByRoomIds: mock(async () => []),
  getMemoriesByIds: mock(async () => []),
  getCachedEmbeddings: mock(async () => []),
  log: mock(async () => undefined),
  searchMemories: mock(async () => []),
  createMemory: mock(async () => stringToUuid(uuidv4())),
  deleteMemory: mock(async () => undefined),
  deleteAllMemories: mock(async () => undefined),
  countMemories: mock(async () => 0),
  getRoomsByIds: mock(async () => []),
  createRooms: mock(async () => [stringToUuid(uuidv4())]),
  deleteRoom: mock(async () => undefined),
  getRoomsForParticipant: mock(async () => []),
  getRoomsForParticipants: mock(async () => []),
  addParticipantsRoom: mock(async () => true),
  removeParticipant: mock(async () => true),
  getParticipantsForEntity: mock(async () => []),
  getParticipantsForRoom: mock(async () => []),
  getParticipantUserState: mock(async () => null),
  setParticipantUserState: mock(async () => undefined),
  createRelationship: mock(async () => true),
  getRelationship: mock(async () => null),
  getRelationships: mock(async () => []),
  getAgent: mock(async () => null),
  getAgents: mock(async () => []),
  createAgent: mock(async () => true),
  updateAgent: mock(async () => true),
  deleteAgent: mock(async () => true),
  ensureEmbeddingDimension: mock(async () => undefined),
  getEntitiesForRoom: mock(async () => []),
  updateEntity: mock(async () => undefined),
  getComponent: mock(async () => null),
  getComponents: mock(async () => []),
  createComponent: mock(async () => true),
  updateComponent: mock(async () => undefined),
  deleteComponent: mock(async () => undefined),
  createWorld: mock(async () => stringToUuid(uuidv4())),
  getWorld: mock(async () => null),
  getAllWorlds: mock(async () => []),
  updateWorld: mock(async () => undefined),
  updateRoom: mock(async () => undefined),
  getRoomsByWorld: mock(async () => []),
  updateRelationship: mock(async () => undefined),
  getCache: mock(async () => undefined),
  setCache: mock(async () => true),
  deleteCache: mock(async () => true),
  createTask: mock(async () => stringToUuid(uuidv4())),
  getTasks: mock(async () => []),
  getTask: mock(async () => null),
  getTasksByName: mock(async () => []),
  updateTask: mock(async () => undefined),
  deleteTask: mock(async () => undefined),
  updateMemory: mock(async () => true),
  getLogs: mock(async () => []),
  deleteLog: mock(async () => undefined),
  removeWorld: mock(async () => undefined),
  deleteRoomsByWorldId: function (_worldId: UUID): Promise<void> {
    throw new Error('Function not implemented.');
  },
  getMemoriesByWorldId: function (_params: {
    worldId: UUID;
    count?: number;
    tableName?: string;
  }): Promise<Memory[]> {
    throw new Error('Function not implemented.');
  },
  deleteManyMemories: mock(async () => undefined),
};

// Mock action creator (matches your example)
const createMockAction = (name: string): Action => ({
  name,
  description: `Test action ${name}`,
  similes: [`like ${name}`],
  examples: [],
  handler: mock(async () => undefined),
  validate: mock(async () => true),
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
    // Clear all mocks before each test
    // Note: bun:test doesn't have a global clearAllMocks equivalent
    // Only clear mocks that need to be reset between tests
    if (mockDatabaseAdapter.log && 'mockReset' in mockDatabaseAdapter.log) {
      (mockDatabaseAdapter.log as any).mockReset();
    }

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
      const initMock = mock(async () => undefined);
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
      const actionHandler = mock();
      const providerGet = mock(async () => ({ text: 'provider_text' }));
      const modelHandler = mock(async () => 'model_result');

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
      (mockDatabaseAdapter.getAgent as any).mockImplementation(async () => ({
        ...mockCharacter,
        id: agentId, // ensureAgentExists should return the agent
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
      }));
      (mockDatabaseAdapter.updateAgent as any).mockImplementation(async () => true);
      (mockDatabaseAdapter.getEntityByIds as any).mockImplementation(async () => [
        {
          id: agentId,
          agentId: agentId,
          names: [mockCharacter.name],
        },
      ]);
      (mockDatabaseAdapter.getEntitiesByIds as any).mockImplementation(async () => [
        {
          id: agentId,
          agentId: agentId,
          names: [mockCharacter.name],
        },
      ]);
      (mockDatabaseAdapter.getRoomsByIds as any).mockImplementation(async () => []);
      (mockDatabaseAdapter.getParticipantsForRoom as any).mockImplementation(async () => []);

      await runtime.initialize(); // Initialize to process registrations

      expect(runtime.actions.some((a) => a.name === 'TestAction')).toBe(true);
      expect(runtime.providers.some((p) => p.name === 'TestProvider')).toBe(true);
    });
  });

  describe('Initialization', () => {
    it('should call the core runtime initialize method', async () => {
      const coreInitializeSpy = spyOn(CoreAgentRuntime.prototype, 'initialize');
      (coreInitializeSpy as any).mockImplementation(async () => {});

      await runtime.initialize();

      expect(coreInitializeSpy).toHaveBeenCalledTimes(1);

      coreInitializeSpy.mockRestore();
    });

    it('should throw if adapter is not available during initialize', async () => {
      // Create runtime without passing adapter
      const runtimeWithoutAdapter = new AgentRuntime({
        character: mockCharacter,
        agentId: agentId,
      });

      // We expect the core runtime's initialize to throw, so we can mock it to simulate the error
      const coreInitializeSpy = spyOn(CoreAgentRuntime.prototype, 'initialize');
      (coreInitializeSpy as any).mockImplementation(async () => {
        throw new Error('Database adapter not initialized');
      });

      await expect(runtimeWithoutAdapter.initialize()).rejects.toThrow(
        /Database adapter not initialized/
      );

      coreInitializeSpy.mockRestore();
    });
  });

  describe('State Composition', () => {
    it('should call provider get methods', async () => {
      const provider1Get = mock(async () => ({ text: 'p1_text', values: { p1_val: 1 } }));
      const provider2Get = mock(async () => ({ text: 'p2_text', values: { p2_val: 2 } }));
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
      const provider1Get = mock(async () => ({ text: 'p1_text' }));
      const provider2Get = mock(async () => ({ text: 'p2_text' }));
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
      const modelHandler = mock(async () => 'success');
      const modelType = ModelType.TEXT_LARGE;

      runtime.registerModel(modelType, modelHandler);

      const params = { prompt: 'test prompt', someOption: true };
      const result = await runtime.useModel(modelType, params);

      expect(modelHandler).toHaveBeenCalledTimes(1);
      // Check that handler was called with runtime and merged params
      const [runtimeArg, paramsArg] = (modelHandler as any).mock.calls[0];
      expect(runtimeArg).toBeInstanceOf(AgentRuntime);
      expect(runtimeArg.agentId).toBe(runtime.agentId);
      expect(paramsArg.prompt).toBe(params.prompt);
      expect(paramsArg.someOption).toBe(params.someOption);
      expect(paramsArg.runtime).toBeDefined();
      expect(paramsArg.runtime.agentId).toBe(runtime.agentId);
      expect(result).toEqual('success');
      // Check if log was called (part of useModel logic)
      // In the updated runtime, we log once for useModel
      expect(mockDatabaseAdapter.log).toHaveBeenCalledTimes(1);

      // Check that at least one log call contains the modelType
      const logCalls = (mockDatabaseAdapter.log as any).mock.calls;

      // Only check for useModel log since prompt logging might be conditional
      const hasUseModelLog = logCalls.some(
        (call: any[]) =>
          call[0]?.type === `useModel:${modelType}` && call[0]?.body?.modelType === modelType
      );

      expect(hasUseModelLog).toBe(true);
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
      mockActionHandler = mock(async () => undefined);
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

      // Mock the internal _runtime's composeState method
      // @ts-ignore - accessing private property for testing
      const composeStateSpy = spyOn(runtime._runtime, 'composeState');
      (composeStateSpy as any).mockImplementation(async () =>
        createMockState('composed state text')
      );
    });

    it('should find and execute the correct action handler', async () => {
      await runtime.processActions(message, [responseMemory]);

      expect(mockActionHandler).toHaveBeenCalledTimes(1);
      // Check arguments passed to the handler
      expect(mockActionHandler).toHaveBeenCalledWith(
        runtime,
        message,
        expect.objectContaining({ text: 'composed state text' }), // Check composed state
        expect.objectContaining({
          context: expect.objectContaining({
            previousResults: expect.any(Array),
            getPreviousResult: expect.any(Function),
          }),
        }), // options now contains context
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
      // Reset the mock to clear any calls from initialization
      (mockDatabaseAdapter.createEntities as any).mockClear();

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
      const handler = mock();
      const eventName = 'testEvent';
      const eventData = { info: 'data' };

      runtime.on(eventName, handler);
      runtime.emit(eventName, eventData);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(eventData);
    });

    it('should remove event handler with off', () => {
      const handler = mock();
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
        const providerGet = mock(async () => ({ text: 'provider text' }));
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
        expect(runtime.actions.some((a) => a.name === 'testAction')).toBe(true);
      });

      it('should allow registering multiple actions', () => {
        const action1 = createMockAction('testAction1');
        const action2 = createMockAction('testAction2');
        runtime.registerAction(action1);
        runtime.registerAction(action2);
        expect(runtime.actions.some((a) => a.name === 'testAction1')).toBe(true);
        expect(runtime.actions.some((a) => a.name === 'testAction2')).toBe(true);
      });
    });
  });
}); // End of main describe block
