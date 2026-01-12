import { beforeEach, afterEach, describe, expect, it } from 'bun:test';
import { mock, spyOn } from 'bun:test';

// Helper type for bun:test mocks with additional methods
interface BunMockFunction<T extends (...args: never[]) => unknown> {
  (...args: Parameters<T>): ReturnType<T>;
  mockResolvedValue: (value: Awaited<ReturnType<T>>) => BunMockFunction<T>;
  mockResolvedValueOnce: (value: Awaited<ReturnType<T>>) => BunMockFunction<T>;
  mock: {
    calls: Parameters<T>[][];
    results: ReturnType<T>[];
  };
}
import { AgentRuntime } from '../runtime';
import { MemoryType, ModelType, isStreamableModelType } from '../types';
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
  TextStreamResult,
} from '../types';
import { v4 as uuidv4 } from 'uuid';
const stringToUuid = (id: string): UUID => id as UUID;

// --- Mocks ---

// Use hoisted for prompts mock
const mockSplitChunks = mock();
mock.module('../src/utils', () => ({
  splitChunks: mockSplitChunks,
}));

// Use hoisted for ./index mock (safeReplacer)
const mockSafeReplacer = mock((_key, value) => value); // Simple replacer mock
// Don't mock the entire index module to avoid interfering with other tests

// Track adapter readiness across init/close to properly test idempotent initialization
let adapterReady = false;

// Mock IDatabaseAdapter (inline style matching your example)
const mockDatabaseAdapter: IDatabaseAdapter = {
  isRoomParticipant: mock().mockResolvedValue(true),
  db: {},
  init: mock().mockImplementation(async () => {
    adapterReady = true;
  }),
  initialize: mock().mockResolvedValue(undefined),
  isReady: mock().mockImplementation(async () => adapterReady),
  close: mock().mockImplementation(async () => {
    adapterReady = false;
  }),
  getConnection: mock().mockResolvedValue({}),
  getEntitiesByIds: mock().mockResolvedValue([]),
  createEntities: mock().mockResolvedValue(true),
  getMemories: mock().mockResolvedValue([]),
  getMemoryById: mock().mockResolvedValue(null),
  getMemoriesByRoomIds: mock().mockResolvedValue([]),
  getMemoriesByIds: mock().mockResolvedValue([]),
  getCachedEmbeddings: mock().mockResolvedValue([]),
  log: mock().mockResolvedValue(undefined),
  searchMemories: mock().mockResolvedValue([]),
  createMemory: mock().mockResolvedValue(stringToUuid(uuidv4())),
  deleteMemory: mock().mockResolvedValue(undefined),
  deleteManyMemories: mock().mockResolvedValue(undefined),
  deleteAllMemories: mock().mockResolvedValue(undefined),
  countMemories: mock().mockResolvedValue(0),
  getRoomsByIds: mock().mockResolvedValue([]),
  createRooms: mock().mockResolvedValue([stringToUuid(uuidv4())]),
  deleteRoom: mock().mockResolvedValue(undefined),
  getRoomsForParticipant: mock().mockResolvedValue([]),
  getRoomsForParticipants: mock().mockResolvedValue([]),
  addParticipantsRoom: mock().mockResolvedValue(true),
  removeParticipant: mock().mockResolvedValue(true),
  getParticipantsForEntity: mock().mockResolvedValue([]),
  getParticipantsForRoom: mock().mockResolvedValue([]),
  getParticipantUserState: mock().mockResolvedValue(null),
  setParticipantUserState: mock().mockResolvedValue(undefined),
  createRelationship: mock().mockResolvedValue(true),
  getRelationship: mock().mockResolvedValue(null),
  getRelationships: mock().mockResolvedValue([]),
  getAgent: mock().mockResolvedValue(null),
  getAgents: mock().mockResolvedValue([]),
  createAgent: mock().mockResolvedValue(true),
  updateAgent: mock().mockResolvedValue(true),
  deleteAgent: mock().mockResolvedValue(true),
  ensureEmbeddingDimension: mock().mockResolvedValue(undefined),
  getEntitiesForRoom: mock().mockResolvedValue([]),
  updateEntity: mock().mockResolvedValue(undefined),
  getComponent: mock().mockResolvedValue(null),
  getComponents: mock().mockResolvedValue([]),
  createComponent: mock().mockResolvedValue(true),
  updateComponent: mock().mockResolvedValue(undefined),
  deleteComponent: mock().mockResolvedValue(undefined),
  createWorld: mock().mockResolvedValue(stringToUuid(uuidv4())),
  getWorld: mock().mockResolvedValue(null),
  getAllWorlds: mock().mockResolvedValue([]),
  updateWorld: mock().mockResolvedValue(undefined),
  updateRoom: mock().mockResolvedValue(undefined),
  getRoomsByWorld: mock().mockResolvedValue([]),
  updateRelationship: mock().mockResolvedValue(undefined),
  getCache: mock().mockResolvedValue(undefined),
  setCache: mock().mockResolvedValue(true),
  deleteCache: mock().mockResolvedValue(true),
  createTask: mock().mockResolvedValue(stringToUuid(uuidv4())),
  getTasks: mock().mockResolvedValue([]),
  getTask: mock().mockResolvedValue(null),
  getTasksByName: mock().mockResolvedValue([]),
  updateTask: mock().mockResolvedValue(undefined),
  deleteTask: mock().mockResolvedValue(undefined),
  updateMemory: mock().mockResolvedValue(true),
  getLogs: mock().mockResolvedValue([]),
  deleteLog: mock().mockResolvedValue(undefined),
  removeWorld: mock().mockResolvedValue(undefined),
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
};

// Mock action creator (matches your example)
const createMockAction = (name: string): Action => ({
  name,
  description: `Test action ${name}`,
  similes: [`like ${name}`],
  examples: [],
  handler: mock().mockResolvedValue(undefined),
  validate: mock().mockImplementation(async () => true),
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
    mock.restore(); // Bun:test equivalent of clearAllMocks

    // Reset all mock call counts manually but keep return values
    Object.values(mockDatabaseAdapter).forEach((mockFn) => {
      if (mockFn && typeof mockFn.mockClear === 'function') {
        mockFn.mockClear();
      }
    });

    // Reset readiness state between tests
    adapterReady = false;

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
      const initMock = mock().mockResolvedValue(undefined);
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
      const providerGet = mock().mockResolvedValue({ text: 'provider_text' });
      const modelHandler = mock().mockResolvedValue('model_result');

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
      const ensureAgentExistsSpy = spyOn(
        AgentRuntime.prototype,
        'ensureAgentExists'
      ).mockResolvedValue({
        ...mockCharacter,
        id: agentId, // ensureAgentExists should return the agent
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
      });

      (
        mockDatabaseAdapter.getEntitiesByIds as BunMockFunction<
          IDatabaseAdapter['getEntitiesByIds']
        >
      ).mockResolvedValue([
        {
          id: agentId,
          agentId: agentId,
          names: [mockCharacter.name],
          metadata: {},
        },
      ]);
      (
        mockDatabaseAdapter.getRoomsByIds as BunMockFunction<IDatabaseAdapter['getRoomsByIds']>
      ).mockResolvedValue([]);
      (
        mockDatabaseAdapter.getParticipantsForRoom as BunMockFunction<
          IDatabaseAdapter['getParticipantsForRoom']
        >
      ).mockResolvedValue([]);

      await runtime.initialize(); // Initialize to process registrations

      expect(runtime.actions.some((a) => a.name === 'TestAction')).toBe(true);
      expect(runtime.providers.some((p) => p.name === 'TestProvider')).toBe(true);
      expect(runtime.models.has(ModelType.TEXT_SMALL)).toBe(true);
      ensureAgentExistsSpy.mockRestore();
    });
  });

  describe('Initialization', () => {
    let ensureAgentExistsSpy: ReturnType<typeof spyOn<AgentRuntime, 'ensureAgentExists'>>;
    beforeEach(() => {
      // Mock adapter calls needed for a successful initialize
      ensureAgentExistsSpy = spyOn(AgentRuntime.prototype, 'ensureAgentExists').mockResolvedValue({
        ...mockCharacter,
        id: agentId, // ensureAgentExists should return the agent
        createdAt: Date.now(),
        updatedAt: Date.now(),
        enabled: true,
      });
      (
        mockDatabaseAdapter.getEntitiesByIds as BunMockFunction<
          IDatabaseAdapter['getEntitiesByIds']
        >
      ).mockResolvedValue([
        {
          id: agentId,
          agentId: agentId,
          names: [mockCharacter.name],
          metadata: {},
        },
      ]);
      (
        mockDatabaseAdapter.getRoomsByIds as BunMockFunction<IDatabaseAdapter['getRoomsByIds']>
      ).mockResolvedValue([]);
      (
        mockDatabaseAdapter.getParticipantsForRoom as BunMockFunction<
          IDatabaseAdapter['getParticipantsForRoom']
        >
      ).mockResolvedValue([]);
    });

    afterEach(() => {
      ensureAgentExistsSpy.mockRestore();
    });

    it('should call adapter.init and core setup methods for an existing agent', async () => {
      await runtime.initialize();

      expect(mockDatabaseAdapter.init).toHaveBeenCalledTimes(1);
      expect(runtime.ensureAgentExists).toHaveBeenCalledWith(mockCharacter);
      expect(mockDatabaseAdapter.getRoomsByIds).toHaveBeenCalledWith([agentId]);
      expect(mockDatabaseAdapter.createRooms).toHaveBeenCalled();
      expect(mockDatabaseAdapter.addParticipantsRoom).toHaveBeenCalledWith([agentId], agentId);
    });

    it('should create a new agent if one does not exist', async () => {
      // No need to override the spy, initialize should handle it.
      await runtime.initialize();

      expect(mockDatabaseAdapter.init).toHaveBeenCalledTimes(1);
      expect(runtime.ensureAgentExists).toHaveBeenCalledWith(mockCharacter);
      expect(mockDatabaseAdapter.getRoomsByIds).toHaveBeenCalledWith([agentId]);
      expect(mockDatabaseAdapter.createRooms).toHaveBeenCalled();
      expect(mockDatabaseAdapter.addParticipantsRoom).toHaveBeenCalledWith([agentId], agentId);
    });

    it('should skip adapter.init when adapter is already ready (idempotent initialize)', async () => {
      // Simulate adapter already initialized
      adapterReady = true;

      await runtime.initialize();

      expect(mockDatabaseAdapter.isReady).toHaveBeenCalled();
      expect(mockDatabaseAdapter.init).not.toHaveBeenCalled();
      expect(runtime.ensureAgentExists).toHaveBeenCalledWith(mockCharacter);
      expect(mockDatabaseAdapter.getRoomsByIds).toHaveBeenCalledWith([agentId]);
      expect(mockDatabaseAdapter.createRooms).toHaveBeenCalled();
      expect(mockDatabaseAdapter.addParticipantsRoom).toHaveBeenCalledWith([agentId], agentId);
    });

    it('should call adapter.init only once across multiple initialize calls', async () => {
      // First initialize: adapterReady is false; init should be called
      await runtime.initialize();
      // Second initialize: adapterReady should now be true; init should be skipped
      await runtime.initialize();

      expect(mockDatabaseAdapter.isReady).toHaveBeenCalled();
      expect(mockDatabaseAdapter.init).toHaveBeenCalledTimes(1);
    });

    it('should throw if adapter is not available during initialize', async () => {
      // Create runtime without passing adapter
      const runtimeWithoutAdapter = new AgentRuntime({
        character: mockCharacter,
        agentId: agentId,
      });

      // Prevent unhandled rejection from internal initPromise used by services waiting on initialization
      runtimeWithoutAdapter.initPromise.catch(() => {});

      await expect(runtimeWithoutAdapter.initialize()).rejects.toThrow(
        /Database adapter not initialized/
      );
    });

    it('should skip plugin migrations when skipMigrations option is true', async () => {
      const runtimeWithMigrations = new AgentRuntime({
        character: mockCharacter,
        agentId: agentId,
        adapter: mockDatabaseAdapter,
      });

      // Spy on runPluginMigrations
      const runMigrationsSpy = spyOn(
        runtimeWithMigrations,
        'runPluginMigrations' as keyof AgentRuntime
      );

      // Initialize with skipMigrations = true
      await runtimeWithMigrations.initialize({ skipMigrations: true });

      // Verify migrations were not called
      expect(runMigrationsSpy).not.toHaveBeenCalled();
    });

    it('should run plugin migrations by default when skipMigrations is not specified', async () => {
      const runtimeDefault = new AgentRuntime({
        character: mockCharacter,
        agentId: agentId,
        adapter: mockDatabaseAdapter,
      });

      // Spy on runPluginMigrations
      const runMigrationsSpy = spyOn(runtimeDefault, 'runPluginMigrations' as keyof AgentRuntime);

      // Initialize without skipMigrations option (default behavior)
      await runtimeDefault.initialize();

      // Verify migrations were called
      expect(runMigrationsSpy).toHaveBeenCalled();
    });

    // Add more tests for initialize: existing entity, existing room, knowledge processing etc.
  });

  describe('State Composition', () => {
    it('should call provider get methods', async () => {
      const provider1Get = mock().mockResolvedValue({ text: 'p1_text', values: { p1_val: 1 } });
      const provider2Get = mock().mockResolvedValue({ text: 'p2_text', values: { p2_val: 2 } });
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
      expect(state.data?.providers?.P1?.values).toEqual({ p1_val: 1 }); // Check provider data cache
      expect(state.data?.providers?.P2?.values).toEqual({ p2_val: 2 });
    });

    it('should filter providers', async () => {
      const provider1Get = mock().mockResolvedValue({ text: 'p1_text' });
      const provider2Get = mock().mockResolvedValue({ text: 'p2_text' });
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
      const modelHandler = mock().mockResolvedValue('success');
      const modelType = ModelType.TEXT_LARGE;

      runtime.registerModel(modelType, modelHandler, 'test-provider');

      const params = { prompt: 'test prompt', someOption: true };
      const result = await runtime.useModel(modelType, params);

      expect(modelHandler).toHaveBeenCalledTimes(1);
      // Check that handler was called with runtime and params (no runtime in params)
      expect(modelHandler).toHaveBeenCalledWith(runtime, expect.objectContaining(params));
      expect(result).toEqual('success');
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
      mockActionHandler = mock().mockResolvedValue(undefined);
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
      spyOn(runtime, 'composeState').mockResolvedValue(createMockState('composed state text'));
    });

    it('should find and execute the correct action handler', async () => {
      await runtime.processActions(message, [responseMemory]);

      expect(runtime.composeState).toHaveBeenCalled(); // Verify state was composed
      expect(mockActionHandler).toHaveBeenCalledTimes(1);
      // Check arguments passed to the handler
      expect(mockActionHandler).toHaveBeenCalledWith(
        runtime, // runtime instance
        message, // original message
        expect.objectContaining({
          text: 'composed state text',
          values: {},
          data: {},
        }), // accumulated state
        expect.objectContaining({
          actionContext: expect.objectContaining({
            previousResults: [],
            getPreviousResult: expect.any(Function),
          }),
        }), // options with actionContext
        expect.any(Function), // storage callback function
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

    it('should prioritize exact action name matches over fuzzy matches', async () => {
      // Create two actions where one name is a substring of another
      const replyHandler = mock().mockResolvedValue(undefined);
      const replyWithImageHandler = mock().mockResolvedValue(undefined);

      const replyAction: Action = {
        name: 'REPLY',
        description: 'Simple reply action',
        similes: [],
        examples: [],
        handler: replyHandler,
        validate: mock().mockImplementation(async () => true),
      };

      const replyWithImageAction: Action = {
        name: 'REPLY_WITH_IMAGE',
        description: 'Reply with image action',
        similes: [],
        examples: [],
        handler: replyWithImageHandler,
        validate: mock().mockImplementation(async () => true),
      };

      // Register both actions
      runtime.registerAction(replyAction);
      runtime.registerAction(replyWithImageAction);

      // Test 1: When asking for 'REPLY', it should match REPLY exactly, not REPLY_WITH_IMAGE
      responseMemory.content.actions = ['REPLY'];
      await runtime.processActions(message, [responseMemory]);

      expect(replyHandler).toHaveBeenCalledTimes(1);
      expect(replyWithImageHandler).not.toHaveBeenCalled();

      // Reset mocks
      replyHandler.mockClear();
      replyWithImageHandler.mockClear();

      // Test 2: When asking for 'REPLY_WITH_IMAGE', it should match REPLY_WITH_IMAGE exactly
      responseMemory.content.actions = ['REPLY_WITH_IMAGE'];
      await runtime.processActions(message, [responseMemory]);

      expect(replyWithImageHandler).toHaveBeenCalledTimes(1);
      expect(replyHandler).not.toHaveBeenCalled();
    });
  });

  // --- getActionResults Tests ---
  describe('getActionResults', () => {
    it('should return action results after processActions', async () => {
      const messageId = stringToUuid(uuidv4()) as UUID;
      const testAction: Action = {
        name: 'TEST_ACTION',
        description: 'Test action',
        similes: [],
        examples: [],
        handler: mock().mockResolvedValue({
          success: true,
          text: 'Action completed',
          data: { result: 'test data' },
          values: { testValue: 123 },
        }),
        validate: mock().mockResolvedValue(true),
      };

      runtime.registerAction(testAction);

      const memory: Memory = {
        id: messageId,
        entityId: agentId,
        agentId: agentId,
        roomId: stringToUuid(uuidv4()) as UUID,
        content: { text: 'test message' },
        createdAt: Date.now(),
      };

      const responses: Memory[] = [
        {
          id: stringToUuid(uuidv4()) as UUID,
          entityId: agentId,
          agentId: agentId,
          roomId: memory.roomId,
          content: {
            text: 'response',
            actions: ['TEST_ACTION'],
          },
          createdAt: Date.now(),
        },
      ];

      spyOn(runtime, 'composeState').mockResolvedValue(createMockState('test state'));

      await runtime.processActions(memory, responses);
      const results = runtime.getActionResults(messageId);

      expect(results).toHaveLength(1);
      expect(results[0]).toHaveProperty('success', true);
      expect(results[0]).toHaveProperty('text', 'Action completed');
      expect(results[0].data).toEqual({ result: 'test data' });
      expect(results[0].values).toEqual({ testValue: 123 });
    });

    it('should return empty array for unknown messageId', () => {
      const unknownId = stringToUuid(uuidv4()) as UUID;
      const results = runtime.getActionResults(unknownId);
      expect(results).toEqual([]);
    });

    it('should return empty array when no actions were executed', async () => {
      const messageId = stringToUuid(uuidv4()) as UUID;
      const memory: Memory = {
        id: messageId,
        entityId: agentId,
        agentId: agentId,
        roomId: stringToUuid(uuidv4()) as UUID,
        content: { text: 'test message' },
        createdAt: Date.now(),
      };

      // Empty responses array - no actions to execute
      const responses: Memory[] = [];

      await runtime.processActions(memory, responses);
      const results = runtime.getActionResults(messageId);

      expect(results).toEqual([]);
    });
  });

  // --- Adapter Passthrough Tests ---
  describe('Adapter Passthrough', () => {
    it('createEntity should call adapter.createEntities', async () => {
      const entityData = {
        id: stringToUuid(uuidv4()),
        agentId: agentId,
        names: ['Test Entity'],
        metadata: {},
      };
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
        const providerGet = mock().mockResolvedValue({ text: 'provider text' });
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

    describe('model settings from character configuration', () => {
      it('should apply character model settings as defaults and allow overrides', async () => {
        // Create character with model settings
        const characterWithSettings: Character = {
          ...mockCharacter,
          settings: {
            MODEL_MAX_TOKEN: 4096,
            MODEL_TEMPERATURE: 0.5,
            MODEL_FREQ_PENALTY: 0.8,
            MODEL_PRESENCE_PENALTY: 0.9,
            // Test invalid values that should be ignored
            MODEL_INVALID: 'not-a-number',
          },
        };

        // Create runtime with character settings
        const runtimeWithSettings = new AgentRuntime({
          character: characterWithSettings,
          adapter: mockDatabaseAdapter,
        });

        // Mock a model handler to capture params
        let capturedParams: any = null;
        const mockHandler = mock().mockImplementation(async (_runtime: any, params: any) => {
          capturedParams = params;
          return 'test response';
        });

        // Register the mock model
        runtimeWithSettings.registerModel(ModelType.TEXT_SMALL, mockHandler, 'test-provider');

        // Test 1: Model settings are applied as defaults
        await runtimeWithSettings.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test prompt',
        });

        expect(capturedParams.maxTokens).toBe(4096);
        expect(capturedParams.temperature).toBe(0.5);
        expect(capturedParams.frequencyPenalty).toBe(0.8);
        expect(capturedParams.presencePenalty).toBe(0.9);
        expect(capturedParams.prompt).toBe('test prompt');

        // Test 2: Explicit parameters override character defaults
        await runtimeWithSettings.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test prompt 2',
          temperature: 0.2,
          maxTokens: 2048,
        });

        expect(capturedParams.temperature).toBe(0.2);
        expect(capturedParams.maxTokens).toBe(2048);
        expect(capturedParams.frequencyPenalty).toBe(0.8); // Still from character
        expect(capturedParams.presencePenalty).toBe(0.9); // Still from character

        // Test 3: No settings configured - use only provided params
        const characterNoSettings: Character = {
          ...mockCharacter,
          name: 'TestAgentNoSettings',
        };
        const runtimeNoSettings = new AgentRuntime({
          character: characterNoSettings,
          adapter: mockDatabaseAdapter,
        });

        // Use same mockHandler for the second test
        mockHandler.mockClear();
        runtimeNoSettings.registerModel(ModelType.TEXT_SMALL, mockHandler, 'test-provider');

        await runtimeNoSettings.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test prompt 3',
          temperature: 0.7,
        });

        expect(capturedParams.temperature).toBe(0.7);
        expect(capturedParams.maxTokens).toBeUndefined();
        expect(capturedParams.frequencyPenalty).toBeUndefined();
        expect(capturedParams.presencePenalty).toBeUndefined();
      });

      it('should preserve explicitly provided empty string for user parameter in useModel', async () => {
        // Mock a model handler to capture params
        let capturedParams: any = null;
        const mockHandler = mock().mockImplementation(async (_runtime: any, params: any) => {
          capturedParams = params;
          return 'test response';
        });

        runtime.registerModel(ModelType.TEXT_SMALL, mockHandler, 'test-provider');

        // Test: Explicitly set user to empty string should be preserved
        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test prompt',
          user: '',
        });

        expect(capturedParams.user).toBe('');
        expect(capturedParams.prompt).toBe('test prompt');
      });

      it('should preserve explicitly provided null for user parameter in useModel', async () => {
        // Mock a model handler to capture params
        let capturedParams: any = null;
        const mockHandler = mock().mockImplementation(async (_runtime: any, params: any) => {
          capturedParams = params;
          return 'test response';
        });

        runtime.registerModel(ModelType.TEXT_SMALL, mockHandler, 'test-provider');

        // Test: Explicitly set user to null should be preserved
        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test prompt',
          user: null,
        });

        expect(capturedParams.user).toBeNull();
        expect(capturedParams.prompt).toBe('test prompt');
      });

      it('should auto-populate user from character name when not provided in useModel', async () => {
        // Mock a model handler to capture params
        let capturedParams: any = null;
        const mockHandler = mock().mockImplementation(async (_runtime: any, params: any) => {
          capturedParams = params;
          return 'test response';
        });

        runtime.registerModel(ModelType.TEXT_SMALL, mockHandler, 'test-provider');

        // Test: When user is undefined, should auto-populate from character name
        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test prompt',
        });

        expect(capturedParams.user).toBe('Test Character');
        expect(capturedParams.prompt).toBe('test prompt');
      });
    });

    describe('model settings from character configuration', () => {
      it('should support per-model-type configuration with proper fallback chain', async () => {
        // Create character with mixed settings: defaults, model-specific, and legacy
        const characterWithMixedSettings: Character = {
          ...mockCharacter,
          settings: {
            // Default settings (apply to all models)
            DEFAULT_TEMPERATURE: 0.7,
            DEFAULT_MAX_TOKENS: 2048,

            // Model-specific settings (override defaults)
            TEXT_SMALL_TEMPERATURE: 0.5,
            TEXT_SMALL_MAX_TOKENS: 1024,
            TEXT_LARGE_TEMPERATURE: 0.8,
            TEXT_LARGE_FREQUENCY_PENALTY: 0.5,
            OBJECT_SMALL_TEMPERATURE: 0.3,
            OBJECT_LARGE_PRESENCE_PENALTY: 0.6,

            // Legacy settings (should be lowest priority)
            MODEL_TEMPERATURE: 0.9,
            MODEL_MAX_TOKEN: 4096,
            MODEL_FREQ_PENALTY: 0.7,
            MODEL_PRESENCE_PENALTY: 0.8,
          },
        };

        const runtimeWithMixedSettings = new AgentRuntime({
          character: characterWithMixedSettings,
          adapter: mockDatabaseAdapter,
        });

        // Mock handlers to capture params
        let capturedTextSmall: any = null;
        let capturedTextLarge: any = null;
        let capturedObjectSmall: any = null;
        let capturedObjectLarge: any = null;

        const mockTextSmallHandler = mock().mockImplementation(
          async (_runtime: any, params: any) => {
            capturedTextSmall = params;
            return 'text small response';
          }
        );
        const mockTextLargeHandler = mock().mockImplementation(
          async (_runtime: any, params: any) => {
            capturedTextLarge = params;
            return 'text large response';
          }
        );
        const mockObjectSmallHandler = mock().mockImplementation(
          async (_runtime: any, params: any) => {
            capturedObjectSmall = params;
            return { type: 'small' };
          }
        );
        const mockObjectLargeHandler = mock().mockImplementation(
          async (_runtime: any, params: any) => {
            capturedObjectLarge = params;
            return { type: 'large' };
          }
        );

        // Register all models
        runtimeWithMixedSettings.registerModel(
          ModelType.TEXT_SMALL,
          mockTextSmallHandler,
          'test-provider'
        );
        runtimeWithMixedSettings.registerModel(
          ModelType.TEXT_LARGE,
          mockTextLargeHandler,
          'test-provider'
        );
        runtimeWithMixedSettings.registerModel(
          ModelType.OBJECT_SMALL,
          mockObjectSmallHandler,
          'test-provider'
        );
        runtimeWithMixedSettings.registerModel(
          ModelType.OBJECT_LARGE,
          mockObjectLargeHandler,
          'test-provider'
        );

        // Test 1: TEXT_SMALL - should use model-specific settings, fall back to defaults/legacy
        await runtimeWithMixedSettings.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test text small',
        });

        expect(capturedTextSmall.temperature).toBe(0.5); // Model-specific
        expect(capturedTextSmall.maxTokens).toBe(1024); // Model-specific
        expect(capturedTextSmall.frequencyPenalty).toBe(0.7); // Legacy fallback
        expect(capturedTextSmall.presencePenalty).toBe(0.8); // Legacy fallback

        // Test 2: TEXT_LARGE - mixed model-specific and defaults
        await runtimeWithMixedSettings.useModel(ModelType.TEXT_LARGE, {
          prompt: 'test text large',
        });

        expect(capturedTextLarge.temperature).toBe(0.8); // Model-specific
        expect(capturedTextLarge.maxTokens).toBe(2048); // Default fallback
        expect(capturedTextLarge.frequencyPenalty).toBe(0.5); // Model-specific
        expect(capturedTextLarge.presencePenalty).toBe(0.8); // Legacy fallback

        // Test 3: OBJECT_SMALL - some model-specific, rest from defaults/legacy
        await runtimeWithMixedSettings.useModel(ModelType.OBJECT_SMALL, {
          prompt: 'test object small',
        });

        expect(capturedObjectSmall.temperature).toBe(0.3); // Model-specific
        expect(capturedObjectSmall.maxTokens).toBe(2048); // Default fallback
        expect(capturedObjectSmall.frequencyPenalty).toBe(0.7); // Legacy fallback
        expect(capturedObjectSmall.presencePenalty).toBe(0.8); // Legacy fallback

        // Test 4: OBJECT_LARGE - minimal model-specific settings
        await runtimeWithMixedSettings.useModel(ModelType.OBJECT_LARGE, {
          prompt: 'test object large',
        });

        expect(capturedObjectLarge.temperature).toBe(0.7); // Default fallback
        expect(capturedObjectLarge.maxTokens).toBe(2048); // Default fallback
        expect(capturedObjectLarge.frequencyPenalty).toBe(0.7); // Legacy fallback
        expect(capturedObjectLarge.presencePenalty).toBe(0.6); // Model-specific
      });

      it('should allow direct params to override all configuration levels', async () => {
        const characterWithAllSettings: Character = {
          ...mockCharacter,
          settings: {
            // All levels of configuration
            DEFAULT_TEMPERATURE: 0.7,
            TEXT_SMALL_TEMPERATURE: 0.5,
            MODEL_TEMPERATURE: 0.9,
          },
        };

        const runtime = new AgentRuntime({
          character: characterWithAllSettings,
          adapter: mockDatabaseAdapter,
        });

        let capturedParams: any = null;
        const mockHandler = mock().mockImplementation(async (_runtime: any, params: any) => {
          capturedParams = params;
          return 'response';
        });

        runtime.registerModel(ModelType.TEXT_SMALL, mockHandler, 'test-provider');

        // Direct params should override everything
        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test',
          temperature: 0.1, // This should win
        });

        expect(capturedParams.temperature).toBe(0.1);
      });

      it('should handle models without specific configuration support', async () => {
        const characterWithSettings: Character = {
          ...mockCharacter,
          settings: {
            DEFAULT_TEMPERATURE: 0.7,
            TEXT_SMALL_TEMPERATURE: 0.5,
            // No specific settings for TEXT_REASONING_SMALL
          },
        };

        const runtime = new AgentRuntime({
          character: characterWithSettings,
          adapter: mockDatabaseAdapter,
        });

        let capturedParams: any = null;
        const mockHandler = mock().mockImplementation(async (_runtime: any, params: any) => {
          capturedParams = params;
          return 'response';
        });

        // Register a model type that doesn't have specific configuration support
        runtime.registerModel(ModelType.TEXT_REASONING_SMALL, mockHandler, 'test-provider');

        await runtime.useModel(ModelType.TEXT_REASONING_SMALL, {
          prompt: 'test reasoning',
        });

        // Should fall back to default settings
        expect(capturedParams.temperature).toBe(0.7);
        expect(capturedParams.maxTokens).toBeUndefined(); // No default for this
      });

      it('should validate and ignore invalid numeric values at all configuration levels', async () => {
        const characterWithInvalidSettings: Character = {
          ...mockCharacter,
          settings: {
            // Mix of valid and invalid values at different levels
            DEFAULT_TEMPERATURE: 'not-a-number',
            DEFAULT_MAX_TOKENS: 2048,
            TEXT_SMALL_TEMPERATURE: 0.5,
            TEXT_SMALL_MAX_TOKENS: 'invalid',
            TEXT_SMALL_FREQUENCY_PENALTY: 0.5,
            MODEL_TEMPERATURE: 0.8,
            MODEL_PRESENCE_PENALTY: 0.8,
          },
        };

        const runtime = new AgentRuntime({
          character: characterWithInvalidSettings,
          adapter: mockDatabaseAdapter,
        });

        let capturedParams: any = null;
        const mockHandler = mock().mockImplementation(async (_runtime: any, params: any) => {
          capturedParams = params;
          return 'response';
        });

        runtime.registerModel(ModelType.TEXT_SMALL, mockHandler, 'test-provider');

        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: 'test invalid',
        });

        // Valid values should be used, invalid ones ignored
        expect(capturedParams.temperature).toBe(0.5); // Valid model-specific
        expect(capturedParams.maxTokens).toBe(2048); // Valid default (model-specific was invalid)
        expect(capturedParams.frequencyPenalty).toBe(0.5); // Valid model-specific
        expect(capturedParams.presencePenalty).toBe(0.8); // Valid legacy
      });
    });
  });

  describe('Streaming Support', () => {
    describe('isStreamableModelType', () => {
      it('should return true for TEXT_SMALL', () => {
        expect(isStreamableModelType(ModelType.TEXT_SMALL)).toBe(true);
      });

      it('should return true for TEXT_LARGE', () => {
        expect(isStreamableModelType(ModelType.TEXT_LARGE)).toBe(true);
      });

      it('should return false for TEXT_EMBEDDING', () => {
        expect(isStreamableModelType(ModelType.TEXT_EMBEDDING)).toBe(false);
      });

      it('should return false for OBJECT_SMALL', () => {
        expect(isStreamableModelType(ModelType.OBJECT_SMALL)).toBe(false);
      });

      it('should return false for IMAGE', () => {
        expect(isStreamableModelType(ModelType.IMAGE)).toBe(false);
      });
    });

    describe('useModel with streaming', () => {
      it('should return string when stream is false', async () => {
        const mockHandler = mock().mockResolvedValue('Non-streaming response');
        runtime.registerModel(ModelType.TEXT_LARGE, mockHandler, 'test-provider');

        const result = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: 'Test prompt',
          stream: false,
        });

        expect(typeof result).toBe('string');
        expect(result).toBe('Non-streaming response');
      });

      it('should return string without streaming context', async () => {
        const mockHandler = mock().mockResolvedValue('Direct response');
        runtime.registerModel(ModelType.TEXT_LARGE, mockHandler, 'test-provider');

        const result = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: 'Test prompt',
        });

        expect(typeof result).toBe('string');
        expect(result).toBe('Direct response');
      });

      it('should auto-stream when streaming context is active', async () => {
        // Configure the streaming context manager for Node.js environment
        const { setStreamingContextManager } = await import('../streaming-context');
        const { createNodeStreamingContextManager } = await import('../streaming-context.node');
        setStreamingContextManager(createNodeStreamingContextManager());

        const { runWithStreamingContext } = await import('../streaming-context');

        const chunks: string[] = [];
        const mockStreamResult: TextStreamResult = {
          textStream: (async function* () {
            yield 'Hello';
            yield ' World';
          })(),
          text: Promise.resolve('Hello World'),
          usage: Promise.resolve(undefined),
          finishReason: Promise.resolve('stop'),
        };

        const mockHandler = mock().mockResolvedValue(mockStreamResult);
        runtime.registerModel(ModelType.TEXT_LARGE, mockHandler, 'test-provider');

        const streamingContext = {
          onStreamChunk: async (chunk: string) => {
            chunks.push(chunk);
          },
        };

        const result = await runWithStreamingContext(streamingContext, async () => {
          return runtime.useModel(ModelType.TEXT_LARGE, {
            prompt: 'Test prompt',
          });
        });

        // Should return string (not TextStreamResult)
        expect(typeof result).toBe('string');
        // Handler should have been called with stream: true
        const callArgs = mockHandler.mock.calls[0];
        expect(callArgs[1].stream).toBe(true);
      });

      it('should isolate streaming contexts in parallel calls (AsyncLocalStorage)', async () => {
        // Configure the streaming context manager for Node.js environment
        const { setStreamingContextManager } = await import('../streaming-context');
        const { createNodeStreamingContextManager } = await import('../streaming-context.node');
        setStreamingContextManager(createNodeStreamingContextManager());

        const { runWithStreamingContext } = await import('../streaming-context');

        // Track chunks received by each context
        const context1Chunks: string[] = [];
        const context2Chunks: string[] = [];
        const context3Chunks: string[] = [];

        // Create mock handlers that return different streams for each call
        // Note: The runtime uses XmlTextStreamExtractor which extracts content from <text> tags
        let callCount = 0;
        const mockHandler = mock().mockImplementation(() => {
          callCount++;
          const id = callCount;
          // Stream XML with <text> tags so XmlTextStreamExtractor can extract the content
          return Promise.resolve({
            textStream: (async function* () {
              yield `<response><text>ctx${id}-`;
              await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate async delay
              yield `part1 ctx${id}-part2</text></response>`;
            })(),
            text: Promise.resolve(
              `<response><text>ctx${id}-part1 ctx${id}-part2</text></response>`
            ),
            usage: Promise.resolve(undefined),
            finishReason: Promise.resolve('stop'),
          });
        });

        runtime.registerModel(ModelType.TEXT_LARGE, mockHandler, 'test-provider');

        // Run 3 streaming contexts in parallel
        const [result1, result2, result3] = await Promise.all([
          runWithStreamingContext(
            {
              onStreamChunk: async (chunk: string) => {
                context1Chunks.push(chunk);
              },
            },
            async () => runtime.useModel(ModelType.TEXT_LARGE, { prompt: 'Test 1' })
          ),
          runWithStreamingContext(
            {
              onStreamChunk: async (chunk: string) => {
                context2Chunks.push(chunk);
              },
            },
            async () => runtime.useModel(ModelType.TEXT_LARGE, { prompt: 'Test 2' })
          ),
          runWithStreamingContext(
            {
              onStreamChunk: async (chunk: string) => {
                context3Chunks.push(chunk);
              },
            },
            async () => runtime.useModel(ModelType.TEXT_LARGE, { prompt: 'Test 3' })
          ),
        ]);

        // Each context should have received only its own chunks (extracted from <text> tags)
        const context1Text = context1Chunks.join('');
        const context2Text = context2Chunks.join('');
        const context3Text = context3Chunks.join('');

        // Verify each context got its own unique content
        expect(context1Text).toContain('ctx1-');
        expect(context1Text).not.toContain('ctx2-');
        expect(context1Text).not.toContain('ctx3-');

        expect(context2Text).toContain('ctx2-');
        expect(context2Text).not.toContain('ctx1-');
        expect(context2Text).not.toContain('ctx3-');

        expect(context3Text).toContain('ctx3-');
        expect(context3Text).not.toContain('ctx1-');
        expect(context3Text).not.toContain('ctx2-');

        // All results should be strings (full XML)
        expect(typeof result1).toBe('string');
        expect(typeof result2).toBe('string');
        expect(typeof result3).toBe('string');
      });
    });
  });

  describe('ensureEmbeddingDimension', () => {
    it('should use EMBEDDING_DIMENSION from settings and skip API call', async () => {
      const characterWithEmbeddingDimension: Character = {
        ...mockCharacter,
        settings: {
          EMBEDDING_DIMENSION: 1536,
        },
      };

      const runtimeWithDimension = new AgentRuntime({
        character: characterWithEmbeddingDimension,
        agentId: agentId,
        adapter: mockDatabaseAdapter,
      });

      // Register a mock embedding model
      const embeddingHandler = mock().mockResolvedValue([0.1, 0.2, 0.3]);
      runtimeWithDimension.registerModel(
        ModelType.TEXT_EMBEDDING,
        embeddingHandler,
        'test-provider'
      );

      // Reset mock call counts
      (mockDatabaseAdapter.ensureEmbeddingDimension as any).mockClear();

      await runtimeWithDimension.ensureEmbeddingDimension();

      // Should call ensureEmbeddingDimension with the configured value
      expect(mockDatabaseAdapter.ensureEmbeddingDimension).toHaveBeenCalledWith(1536);
      // Should NOT call the embedding model since dimension was provided
      expect(embeddingHandler).not.toHaveBeenCalled();
    });

    it('should fall back to API call when EMBEDDING_DIMENSION is not set', async () => {
      const runtimeWithoutDimension = new AgentRuntime({
        character: mockCharacter,
        agentId: agentId,
        adapter: mockDatabaseAdapter,
      });

      // Register a mock embedding model that returns a 768-dim vector
      const embeddingHandler = mock().mockResolvedValue(new Array(768).fill(0.1));
      runtimeWithoutDimension.registerModel(
        ModelType.TEXT_EMBEDDING,
        embeddingHandler,
        'test-provider'
      );

      // Reset mock call counts
      (mockDatabaseAdapter.ensureEmbeddingDimension as any).mockClear();

      await runtimeWithoutDimension.ensureEmbeddingDimension();

      // Should call the embedding model to determine dimension
      expect(embeddingHandler).toHaveBeenCalled();
      // Should call ensureEmbeddingDimension with the inferred dimension
      expect(mockDatabaseAdapter.ensureEmbeddingDimension).toHaveBeenCalledWith(768);
    });

    it('should fall back to API call when EMBEDDING_DIMENSION is invalid', async () => {
      const characterWithInvalidDimension: Character = {
        ...mockCharacter,
        settings: {
          EMBEDDING_DIMENSION: 'not-a-number',
        },
      };

      const runtimeWithInvalidDimension = new AgentRuntime({
        character: characterWithInvalidDimension,
        agentId: agentId,
        adapter: mockDatabaseAdapter,
      });

      // Register a mock embedding model
      const embeddingHandler = mock().mockResolvedValue(new Array(512).fill(0.1));
      runtimeWithInvalidDimension.registerModel(
        ModelType.TEXT_EMBEDDING,
        embeddingHandler,
        'test-provider'
      );

      // Reset mock call counts
      (mockDatabaseAdapter.ensureEmbeddingDimension as any).mockClear();

      await runtimeWithInvalidDimension.ensureEmbeddingDimension();

      // Should fall back to API call since dimension is invalid
      expect(embeddingHandler).toHaveBeenCalled();
      expect(mockDatabaseAdapter.ensureEmbeddingDimension).toHaveBeenCalledWith(512);
    });

    it('should handle string EMBEDDING_DIMENSION setting', async () => {
      const characterWithStringDimension: Character = {
        ...mockCharacter,
        settings: {
          EMBEDDING_DIMENSION: '3072',
        },
      };

      const runtimeWithStringDimension = new AgentRuntime({
        character: characterWithStringDimension,
        agentId: agentId,
        adapter: mockDatabaseAdapter,
      });

      // Register a mock embedding model
      const embeddingHandler = mock().mockResolvedValue([0.1]);
      runtimeWithStringDimension.registerModel(
        ModelType.TEXT_EMBEDDING,
        embeddingHandler,
        'test-provider'
      );

      // Reset mock call counts
      (mockDatabaseAdapter.ensureEmbeddingDimension as any).mockClear();

      await runtimeWithStringDimension.ensureEmbeddingDimension();

      // Should parse string and use it
      expect(mockDatabaseAdapter.ensureEmbeddingDimension).toHaveBeenCalledWith(3072);
      expect(embeddingHandler).not.toHaveBeenCalled();
    });
  });
}); // End of main describe block
