/**
 * Mock factory functions for testing
 */

import type {
  Character,
  DatabaseAdapter,
  Evaluator,
  IAgentRuntime,
  Memory,
  Service,
  State,
  UUID,
} from '@elizaos/core';
import { ServiceType } from '@elizaos/core';
import type { NextFunction, Request, Response } from 'express';
import { mock } from 'bun:test';

/**
 * Creates a mock IAgentRuntime with all required properties
 */
export function createMockAgentRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
  const db = { execute: mock(() => Promise.resolve([])) };

  const baseRuntime: IAgentRuntime = {
    // Properties from IAgentRuntime interface
    agentId: '123e4567-e89b-12d3-a456-426614174000' as UUID,
    character: {
      id: 'test-character-id' as UUID,
      name: 'Test Character',
      description: 'A test character',
      bio: ['Test bio'],
      system: 'Test system',
      modelProvider: 'openai',
      settings: {
        model: 'gpt-4',
        secrets: {},
      },
    } as Character,
    providers: [],
    actions: [],
    evaluators: [],
    plugins: [],
    services: new Map(),
    events: new Map(),
    fetch: null,
    routes: [],

    // IAgentRuntime methods
    registerPlugin: mock(() => Promise.resolve()),
    initialize: mock(() => Promise.resolve()),
    getConnection: mock(() => Promise.resolve(db)),
    getService: mock(() => null),
    getAllServices: mock(() => new Map()),
    registerService: mock(() => Promise.resolve()),
    registerDatabaseAdapter: mock(),
    setSetting: mock(),
    getSetting: mock((key: string) => overrides?.character?.settings?.[key]),
    getConversationLength: mock(() => 10),
    processActions: mock(() => Promise.resolve()),
    evaluate: mock(() => Promise.resolve([] as Evaluator[])),
    registerProvider: mock(),
    registerAction: mock(),
    registerEvaluator: mock(),
    ensureConnections: mock(() => Promise.resolve()),
    ensureConnection: mock(() => Promise.resolve()),
    ensureParticipantInRoom: mock(() => Promise.resolve()),
    ensureWorldExists: mock(() => Promise.resolve()),
    ensureRoomExists: mock(() => Promise.resolve()),
    composeState: mock(() => Promise.resolve({} as State)),
    useModel: mock(() => Promise.resolve('mock response' as any)),
    registerModel: mock(),
    getModel: mock(() => undefined),
    registerEvent: mock(),
    getEvent: mock(() => undefined),
    emitEvent: mock(() => Promise.resolve()),
    registerTaskWorker: mock(),
    getTaskWorker: mock(() => undefined),
    stop: mock(() => Promise.resolve()),
    addEmbeddingToMemory: mock((memory: Memory) => Promise.resolve(memory)),
    queueEmbeddingGeneration: mock(() => Promise.resolve()),
    createRunId: mock(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    startRun: mock(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    endRun: mock(),
    getCurrentRunId: mock(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    getEntityById: mock(() => Promise.resolve(null)),
    getRoom: mock(() => Promise.resolve(null)),
    createEntity: mock(() => Promise.resolve(true)),
    createRoom: mock(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    addParticipant: mock(() => Promise.resolve(true)),
    getRooms: mock(() => Promise.resolve([])),
    registerSendHandler: mock(),
    sendMessageToTarget: mock(() => Promise.resolve()),

    // IDatabaseAdapter properties and methods
    db,
    isReady: mock(() => Promise.resolve(true)),
    init: mock(() => Promise.resolve()),
    runMigrations: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    getAgent: mock(() => Promise.resolve(null)),
    getAgents: mock(() => Promise.resolve([])),
    createAgent: mock(() => Promise.resolve(true)),
    updateAgent: mock(() => Promise.resolve(true)),
    deleteAgent: mock(() => Promise.resolve(true)),
    ensureEmbeddingDimension: mock(() => Promise.resolve()),
    getEntityByIds: mock(() => Promise.resolve(null)),
    getEntitiesForRoom: mock(() => Promise.resolve([])),
    createEntities: mock(() => Promise.resolve(true)),
    updateEntity: mock(() => Promise.resolve()),
    getComponent: mock(() => Promise.resolve(null)),
    getComponents: mock(() => Promise.resolve([])),
    createComponent: mock(() => Promise.resolve(true)),
    updateComponent: mock(() => Promise.resolve()),
    deleteComponent: mock(() => Promise.resolve()),
    getMemories: mock(() => Promise.resolve([])),
    getAllMemories: mock(() => Promise.resolve([])),
    clearAllAgentMemories: mock(() => Promise.resolve()),
    getMemoryById: mock(() => Promise.resolve(null)),
    getMemoriesByIds: mock(() => Promise.resolve([])),
    getMemoriesByRoomIds: mock(() => Promise.resolve([])),
    getCachedEmbeddings: mock(() => Promise.resolve([])),
    log: mock(() => Promise.resolve()),
    getLogs: mock(() => Promise.resolve([])),
    deleteLog: mock(() => Promise.resolve()),
    searchMemories: mock(() => Promise.resolve([])),
    createMemory: mock(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    updateMemory: mock(() => Promise.resolve(true)),
    deleteMemory: mock(() => Promise.resolve()),
    deleteManyMemories: mock(() => Promise.resolve()),
    deleteAllMemories: mock(() => Promise.resolve()),
    countMemories: mock(() => Promise.resolve(0)),
    createWorld: mock(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getWorld: mock(() => Promise.resolve(null)),
    removeWorld: mock(() => Promise.resolve()),
    getAllWorlds: mock(() => Promise.resolve([])),
    updateWorld: mock(() => Promise.resolve()),
    getRoomsByIds: mock(() => Promise.resolve(null)),
    createRooms: mock(() => Promise.resolve([])),
    deleteRoom: mock(() => Promise.resolve()),
    deleteRoomsByWorldId: mock(() => Promise.resolve()),
    updateRoom: mock(() => Promise.resolve()),
    getRoomsForParticipant: mock(() => Promise.resolve([])),
    getRoomsForParticipants: mock(() => Promise.resolve([])),
    getRoomsByWorld: mock(() => Promise.resolve([])),
    removeParticipant: mock(() => Promise.resolve(true)),
    getParticipantsForEntity: mock(() => Promise.resolve([])),
    getParticipantsForRoom: mock(() => Promise.resolve([])),
    addParticipantsRoom: mock(() => Promise.resolve(true)),
    getParticipantUserState: mock(() => Promise.resolve(null)),
    setParticipantUserState: mock(() => Promise.resolve()),
    createRelationship: mock(() => Promise.resolve(true)),
    updateRelationship: mock(() => Promise.resolve()),
    getRelationship: mock(() => Promise.resolve(null)),
    getRelationships: mock(() => Promise.resolve([])),
    getCache: mock(() => Promise.resolve(undefined)),
    setCache: mock(() => Promise.resolve(true)),
    deleteCache: mock(() => Promise.resolve(true)),
    createTask: mock(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getTasks: mock(() => Promise.resolve([])),
    getTask: mock(() => Promise.resolve(null)),
    getTasksByName: mock(() => Promise.resolve([])),
    updateTask: mock(() => Promise.resolve()),
    deleteTask: mock(() => Promise.resolve()),
    getMemoriesByWorldId: mock(() => Promise.resolve([])),

    ...overrides,
  };

  return baseRuntime;
}

/**
 * Creates a mock DatabaseAdapter with message server methods
 */
export function createMockDatabaseAdapter(overrides?: any): DatabaseAdapter & any {
  const baseAdapter = {
    // Core DatabaseAdapter methods
    db: { execute: mock(() => Promise.resolve([])) },
    init: mock(() => Promise.resolve()),
    initialize: mock(() => Promise.resolve()),
    isReady: mock(() => Promise.resolve(true)),
    runMigrations: mock(() => Promise.resolve()),
    close: mock(() => Promise.resolve()),
    getConnection: mock(() => Promise.resolve({ execute: mock(() => Promise.resolve([])) })),

    // Agent methods
    getAgent: mock(() => Promise.resolve(null)),
    getAgents: mock(() => Promise.resolve([])),
    createAgent: mock(() => Promise.resolve(true)),
    updateAgent: mock(() => Promise.resolve(true)),
    deleteAgent: mock(() => Promise.resolve(true)),

    // Entity methods
    getEntityByIds: mock(() => Promise.resolve(null)),
    getEntitiesForRoom: mock(() => Promise.resolve([])),
    createEntities: mock(() => Promise.resolve(true)),
    updateEntity: mock(() => Promise.resolve()),

    // Component methods
    getComponent: mock(() => Promise.resolve(null)),
    getComponents: mock(() => Promise.resolve([])),
    createComponent: mock(() => Promise.resolve(true)),
    updateComponent: mock(() => Promise.resolve()),
    deleteComponent: mock(() => Promise.resolve()),

    // Memory methods
    getMemories: mock(() => Promise.resolve([])),
    getMemoryById: mock(() => Promise.resolve(null)),
    getMemoriesByIds: mock(() => Promise.resolve([])),
    getMemoriesByRoomIds: mock(() => Promise.resolve([])),
    getCachedEmbeddings: mock(() => Promise.resolve([])),
    searchMemories: mock(() => Promise.resolve([])),
    createMemory: mock(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    updateMemory: mock(() => Promise.resolve(true)),
    deleteMemory: mock(() => Promise.resolve()),
    deleteManyMemories: mock(() => Promise.resolve()),
    deleteAllMemories: mock(() => Promise.resolve()),
    countMemories: mock(() => Promise.resolve(0)),
    getMemoriesByWorldId: mock(() => Promise.resolve([])),
    ensureEmbeddingDimension: mock(() => Promise.resolve()),

    // Log methods
    log: mock(() => Promise.resolve()),
    getLogs: mock(() => Promise.resolve([])),
    deleteLog: mock(() => Promise.resolve()),

    // World methods
    createWorld: mock(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getWorld: mock(() => Promise.resolve(null)),
    removeWorld: mock(() => Promise.resolve()),
    getAllWorlds: mock(() => Promise.resolve([])),
    updateWorld: mock(() => Promise.resolve()),

    // Room methods
    getRoomsByIds: mock(() => Promise.resolve(null)),
    createRooms: mock(() => Promise.resolve([])),
    deleteRoom: mock(() => Promise.resolve()),
    deleteRoomsByWorldId: mock(() => Promise.resolve()),
    updateRoom: mock(() => Promise.resolve()),
    getRoomsForParticipant: mock(() => Promise.resolve([])),
    getRoomsForParticipants: mock(() => Promise.resolve([])),
    getRoomsByWorld: mock(() => Promise.resolve([])),

    // Participant methods
    removeParticipant: mock(() => Promise.resolve(true)),
    getParticipantsForEntity: mock(() => Promise.resolve([])),
    getParticipantsForRoom: mock(() => Promise.resolve([])),
    addParticipantsRoom: mock(() => Promise.resolve(true)),
    getParticipantUserState: mock(() => Promise.resolve(null)),
    setParticipantUserState: mock(() => Promise.resolve()),

    // Relationship methods
    createRelationship: mock(() => Promise.resolve(true)),
    updateRelationship: mock(() => Promise.resolve()),
    getRelationship: mock(() => Promise.resolve(null)),
    getRelationships: mock(() => Promise.resolve([])),

    // Cache methods
    getCache: mock(() => Promise.resolve(undefined)),
    setCache: mock(() => Promise.resolve(true)),
    deleteCache: mock(() => Promise.resolve(true)),

    // Task methods
    createTask: mock(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getTasks: mock(() => Promise.resolve([])),
    getTask: mock(() => Promise.resolve(null)),
    getTasksByName: mock(() => Promise.resolve([])),
    updateTask: mock(() => Promise.resolve()),
    deleteTask: mock(() => Promise.resolve()),

    // Message server methods (for AgentServer tests)
    createMessageServer: mock(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' })
    ),
    getMessageServers: mock(() =>
      Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }])
    ),
    getMessageServerById: mock(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' })
    ),
    addAgentToServer: mock(() => Promise.resolve()),
    removeAgentFromServer: mock(() => Promise.resolve()),
    getAgentsForServer: mock(() => Promise.resolve([])),

    // Channel methods
    createChannel: mock(() => Promise.resolve({ id: '123e4567-e89b-12d3-a456-426614174000' })),
    getChannelsForServer: mock(() => Promise.resolve([])),
    getChannelDetails: mock(() => Promise.resolve(null)),
    getChannelParticipants: mock(() => Promise.resolve([])),
    addChannelParticipants: mock(() => Promise.resolve()),
    updateChannel: mock(() => Promise.resolve()),
    deleteChannel: mock(() => Promise.resolve()),

    // Message methods
    createMessage: mock(() => Promise.resolve({ id: 'message-id' })),
    getMessagesForChannel: mock(() => Promise.resolve([])),
    deleteMessage: mock(() => Promise.resolve()),

    // DM methods
    findOrCreateDmChannel: mock(() => Promise.resolve({ id: 'dm-channel-id' })),

    ...overrides,
  };

  return baseAdapter as any;
}

/**
 * Creates a mock Express Request
 */
export function createMockRequest(overrides?: Partial<Request>): Request {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    method: 'GET',
    originalUrl: '/test',
    url: '/test',
    path: '/test',
    ip: '127.0.0.1',
    get: mock((_header: string) => ''),
    header: mock((_header: string) => ''),
    accepts: mock(),
    acceptsCharsets: mock(),
    acceptsEncodings: mock(),
    acceptsLanguages: mock(),
    is: mock(),
    ...overrides,
  } as any;
}

/**
 * Creates a mock Express Response
 */
export function createMockResponse(): Response {
  const res = {
    status: mock().mockReturnThis(),
    json: mock().mockReturnThis(),
    send: mock().mockReturnThis(),
    end: mock().mockReturnThis(),
    setHeader: mock().mockReturnThis(),
    removeHeader: mock().mockReturnThis(),
    set: mock().mockReturnThis(),
    header: mock().mockReturnThis(),
    type: mock().mockReturnThis(),
    sendStatus: mock().mockReturnThis(),
    redirect: mock().mockReturnThis(),
    cookie: mock().mockReturnThis(),
    clearCookie: mock().mockReturnThis(),
    attachment: mock().mockReturnThis(),
    sendFile: mock((_path: string, options?: any, callback?: any) => {
      if (typeof options === 'function') {
        callback = options;
      }
      if (callback) callback();
    }),
    headersSent: false,
    locals: {},
  };

  return res as any;
}

/**
 * Creates a mock Express NextFunction
 */
export function createMockNext(): NextFunction {
  return mock() as any;
}

/**
 * Creates a mock Socket.IO Server
 */
export function createMockSocketIO() {
  return {
    on: mock(),
    emit: mock(),
    to: mock(() => ({
      emit: mock(),
    })),
    sockets: {
      sockets: new Map(),
    },
    close: mock((callback?: () => void) => {
      if (callback) callback();
    }),
  };
}

/**
 * Creates a mock HTTP Server
 */
export function createMockHttpServer() {
  return {
    listen: mock((_port: number, callback?: () => void) => {
      if (callback) callback();
    }),
    close: mock((callback?: () => void) => {
      if (callback) callback();
    }),
    listeners: mock(() => []),
    removeAllListeners: mock(),
    on: mock(),
    once: mock(),
    emit: mock(),
    address: mock(() => ({ port: 3000 })),
    timeout: 0,
    keepAliveTimeout: 5000,
  };
}

/**
 * Creates a mock Service
 */
export function createMockService(overrides?: Partial<Service>): Service {
  return {
    name: 'MockService',
    description: 'A mock service for testing',
    serviceType: ServiceType.WEB_SEARCH,
    getInstance: mock(),
    start: mock(() => Promise.resolve()),
    stop: mock(() => Promise.resolve()),
    ...overrides,
  } as any;
}

/**
 * Creates mock multer file
 */
export function createMockUploadedFile(
  overrides?: Partial<Express.Multer.File>
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'test.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    buffer: Buffer.from('test'),
    size: 12345,
    stream: undefined as any,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}
