/**
 * @fileoverview Mock implementations for IAgentRuntime and related interfaces
 *
 * This module provides comprehensive mock implementations for the core runtime interfaces,
 * designed to support both unit testing and integration testing scenarios.
 */

import type {
  Character,
  IAgentRuntime,
  IDatabaseAdapter,
  Memory,
  State,
  ActionResult,
  UUID,
} from '@elizaos/core';
import { mock } from './mockUtils';

/**
 * Type representing overrides for IAgentRuntime mock creation
 */
export type MockRuntimeOverrides = Partial<IAgentRuntime & IDatabaseAdapter>;

/**
 * Helper class to manage mock runtime initialization promise
 * Mimics the actual AgentRuntime's initPromise behavior
 */
class MockInitPromiseManager {
  promise: Promise<void>;
  resolve!: () => void;
  reject!: (reason?: any) => void;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/**
 * Create a comprehensive mock of IAgentRuntime with intelligent defaults
 *
 * This function provides a fully-featured mock that implements both IAgentRuntime
 * and IDatabaseAdapter interfaces, ensuring compatibility with all test scenarios.
 *
 * **IMPORTANT**: The mock's initPromise is created as a pending promise, matching
 * the actual AgentRuntime behavior. Tests that need initialization to complete
 * should call `(mockRuntime as any).resolveInit()` or provide a pre-resolved
 * initPromise in overrides.
 *
 * @param overrides - Partial object to override specific methods or properties
 * @returns Complete mock implementation of IAgentRuntime with additional test helpers
 *
 * @deprecated Use real runtime testing instead: import { createTestRuntime } from '@elizaos/core/test-utils'
 *
 * @example Legacy Mock Testing (Deprecated)
 * ```typescript
 * import { createMockRuntime } from '@elizaos/core/test-utils';
 *
 * const mockRuntime = createMockRuntime({
 *   getSetting: () => 'test-api-key',
 *   useModel: () => Promise.resolve('mock response')
 * });
 *
 * // Simulate initialization completion (if needed)
 * (mockRuntime as any).resolveInit();
 *
 * // Or wait for initialization
 * await mockRuntime.initPromise;
 * ```
 */
export function createMockRuntime(overrides: MockRuntimeOverrides = {}): IAgentRuntime & {
  resolveInit?: () => void;
  rejectInit?: (reason?: any) => void;
} {
  // Mock character with sensible defaults
  const defaultCharacter: Character = {
    id: 'test-character-id' as UUID,
    name: 'Test Character',
    username: 'test_character',
    system: 'You are a helpful test assistant.',
    bio: ['A character designed for testing purposes'],
    messageExamples: [],
    postExamples: [],
    topics: ['testing', 'development'],
    knowledge: [],
    plugins: [],
    settings: {
      model: 'gpt-4',
      secrets: {},
    },
    style: {
      all: ['be helpful', 'be concise'],
      chat: ['respond quickly'],
      post: ['be engaging'],
    },
  };

  // Mock database connection
  const mockDb = {
    execute: mock().mockResolvedValue([]),
    query: mock().mockResolvedValue([]),
    run: mock().mockResolvedValue({ changes: 1 }),
    all: mock().mockResolvedValue([]),
    get: mock().mockResolvedValue(null),
  };

  // Shared state cache reference for methods that read from cache
  const stateCache: Map<string, any> = (overrides.stateCache as Map<string, any>) || new Map();

  // Create init promise manager to mimic actual runtime behavior
  // Unless overridden, the promise starts pending (not resolved)
  const initManager = new MockInitPromiseManager();

  // Create base runtime mock
  const baseRuntime: IAgentRuntime = {
    // Core Properties
    agentId: 'test-agent-id' as UUID,
    character: overrides.character || defaultCharacter,
    messageService: overrides.messageService ?? null,
    providers: overrides.providers || [],
    actions: overrides.actions || [],
    evaluators: overrides.evaluators || [],
    plugins: overrides.plugins || [],
    services: overrides.services || new Map(),
    events: overrides.events || {},
    fetch: overrides.fetch || null,
    routes: overrides.routes || [],
    logger: overrides.logger || {
      level: 'info',
      trace: () => { },
      debug: () => { },
      info: () => { },
      warn: () => { },
      error: () => { },
      fatal: () => { },
      success: () => { },
      progress: () => { },
      log: () => { },
      clear: () => { },
      child: () => ({}) as any,
    },
    stateCache,
    // Use the manager's promise (pending by default) unless overridden
    initPromise: overrides.initPromise || initManager.promise,

    // Database Properties
    db: overrides.db || mockDb,

    // Core Runtime Methods
    registerPlugin: mock().mockResolvedValue(undefined),
    initialize: mock().mockImplementation(async () => {
      // Automatically resolve initPromise when initialize is called, matching actual runtime
      initManager.resolve();
    }),
    getConnection: mock().mockResolvedValue(mockDb),
    getService: mock().mockReturnValue(null),
    getServicesByType: mock().mockReturnValue([]),
    getAllServices: mock().mockReturnValue(new Map()),
    registerService: mock().mockResolvedValue(undefined),
    getServiceLoadPromise: mock().mockResolvedValue(null),
    getRegisteredServiceTypes: mock().mockReturnValue([]),
    hasService: mock().mockReturnValue(false),
    registerDatabaseAdapter: mock(),
    setSetting: mock(),
    getSetting: mock((key: string) => {
      const defaultSettings: Record<string, any> = {
        TEST_API_KEY: 'test-api-key',
        ...overrides.character?.settings,
      };
      return defaultSettings[key];
    }),
    getConversationLength: mock().mockReturnValue(10),
    getActionResults: (messageId: UUID): ActionResult[] => {
      const cachedState = stateCache?.get(`${messageId}_action_results`);
      return (cachedState?.data?.actionResults as ActionResult[]) || [];
    },
    processActions: mock().mockResolvedValue(undefined),
    evaluate: mock().mockResolvedValue([]),
    registerProvider: mock(),
    registerAction: mock(),
    registerEvaluator: mock(),
    ensureConnection: mock().mockResolvedValue(undefined),
    ensureConnections: mock().mockResolvedValue(undefined),
    ensureParticipantInRoom: mock().mockResolvedValue(undefined),
    ensureWorldExists: mock().mockResolvedValue(undefined),
    ensureRoomExists: mock().mockResolvedValue(undefined),
    composeState: mock().mockResolvedValue({
      values: {},
      data: {},
      text: '',
    } as State),
    useModel: mock().mockResolvedValue('Mock response') as any,
    registerModel: mock(),
    getModel: mock().mockReturnValue(undefined),
    registerEvent: mock(),
    getEvent: mock().mockReturnValue(undefined),
    emitEvent: mock().mockResolvedValue(undefined),
    registerTaskWorker: mock(),
    getTaskWorker: mock().mockReturnValue(undefined),
    stop: mock().mockResolvedValue(undefined),
    addEmbeddingToMemory: mock().mockImplementation((memory: Memory) => Promise.resolve(memory)),
    queueEmbeddingGeneration: mock().mockResolvedValue(undefined),
    createRunId: mock().mockReturnValue('test-run-id' as UUID),
    startRun: mock().mockReturnValue('test-run-id' as UUID),
    endRun: mock(),
    getCurrentRunId: mock().mockReturnValue('test-run-id' as UUID),
    registerSendHandler: mock(),
    sendMessageToTarget: mock().mockResolvedValue(undefined),

    // Database Adapter Methods - Agent Management
    init: mock().mockResolvedValue(undefined),
    isReady: mock().mockResolvedValue(true),
    close: mock().mockResolvedValue(undefined),
    getAgent: mock().mockResolvedValue(null),
    getAgents: mock().mockResolvedValue([]),
    createAgent: mock().mockResolvedValue(true),
    updateAgent: mock().mockResolvedValue(true),
    deleteAgent: mock().mockResolvedValue(true),

    // Entity Management
    getEntityById: mock().mockResolvedValue(null),
    getEntitiesByIds: mock().mockResolvedValue([]),
    getEntitiesForRoom: mock().mockResolvedValue([]),
    createEntity: mock().mockResolvedValue('test-entity-id' as UUID),
    createEntities: mock().mockResolvedValue(true),
    updateEntity: mock().mockResolvedValue(undefined),

    // Component Management
    getComponent: mock().mockResolvedValue(null),
    getComponents: mock().mockResolvedValue([]),
    createComponent: mock().mockResolvedValue('test-component-id' as UUID),
    updateComponent: mock().mockResolvedValue(undefined),
    deleteComponent: mock().mockResolvedValue(undefined),

    // Memory Management
    getMemories: mock().mockResolvedValue([]),
    getAllMemories: overrides.getAllMemories || mock().mockResolvedValue([]),
    clearAllAgentMemories: mock().mockResolvedValue(undefined),
    getMemoryById: mock().mockResolvedValue(null),
    getMemoriesByIds: mock().mockResolvedValue([]),
    getMemoriesByRoomIds: mock().mockResolvedValue([]),
    getMemoriesByWorldId: mock().mockResolvedValue([]),
    getCachedEmbeddings: mock().mockResolvedValue([]),
    log: mock().mockResolvedValue(undefined),
    getLogs: mock().mockResolvedValue([]),
    deleteLog: mock().mockResolvedValue(undefined),
    searchMemories: mock().mockResolvedValue([]),
    createMemory: mock().mockResolvedValue('test-memory-id' as UUID),
    updateMemory: mock().mockResolvedValue(true),
    deleteMemory: mock().mockResolvedValue(undefined),
    deleteManyMemories: mock().mockResolvedValue(undefined),
    deleteAllMemories: mock().mockResolvedValue(undefined),
    countMemories: mock().mockResolvedValue(0),
    ensureEmbeddingDimension: mock().mockResolvedValue(undefined),

    // World Management
    createWorld: mock().mockResolvedValue('test-world-id' as UUID),
    getWorld: mock().mockResolvedValue(null),
    removeWorld: mock().mockResolvedValue(undefined),
    getAllWorlds: mock().mockResolvedValue([]),
    updateWorld: mock().mockResolvedValue(undefined),

    // Room Management
    getRoom: mock().mockResolvedValue(null),
    getRooms: mock().mockResolvedValue([]),
    getRoomsByIds: mock().mockResolvedValue([]),
    createRoom: mock().mockResolvedValue('test-room-id' as UUID),
    createRooms: mock().mockResolvedValue([]),
    deleteRoom: mock().mockResolvedValue(undefined),
    deleteRoomsByWorldId: mock().mockResolvedValue(undefined),
    updateRoom: mock().mockResolvedValue(undefined),
    getRoomsForParticipant: mock().mockResolvedValue([]),
    getRoomsForParticipants: mock().mockResolvedValue([]),
    getRoomsByWorld: mock().mockResolvedValue([]),

    // Participant Management
    addParticipant: mock().mockResolvedValue(true),
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

    // Text Generation (required by IAgentRuntime)
    generateText: mock().mockResolvedValue('Mock generated text'),

    // ElizaOS Integration (must be a function, not a mock, due to type predicate signature)
    hasElizaOS(): this is IAgentRuntime & { elizaOS: any } {
      return false;
    },

    // Apply overrides
    ...overrides,
  };

  // Add test helpers for controlling initialization
  // These can be used in tests to simulate initialization completion or failure
  const runtimeWithHelpers = baseRuntime as IAgentRuntime & {
    resolveInit: () => void;
    rejectInit: (reason?: any) => void;
  };

  runtimeWithHelpers.resolveInit = () => initManager.resolve();
  runtimeWithHelpers.rejectInit = (reason?: any) => initManager.reject(reason);

  return runtimeWithHelpers;
}
