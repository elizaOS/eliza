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
  const db = { execute: mock.fn(() => Promise.resolve([])) };

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
    registerPlugin: mock.fn(() => Promise.resolve()),
    initialize: mock.fn(() => Promise.resolve()),
    getConnection: mock.fn(() => Promise.resolve(db)),
    getService: mock.fn(() => null),
    getAllServices: mock.fn(() => new Map()),
    registerService: mock.fn(() => Promise.resolve()),
    registerDatabaseAdapter: mock.fn(),
    setSetting: mock.fn(),
    getSetting: mock.fn((key: string) => overrides?.character?.settings?.[key]),
    getConversationLength: mock.fn(() => 10),
    processActions: mock.fn(() => Promise.resolve()),
    evaluate: mock.fn(() => Promise.resolve([] as Evaluator[])),
    registerProvider: mock.fn(),
    registerAction: mock.fn(),
    registerEvaluator: mock.fn(),
    ensureConnections: mock.fn(() => Promise.resolve()),
    ensureConnection: mock.fn(() => Promise.resolve()),
    ensureParticipantInRoom: mock.fn(() => Promise.resolve()),
    ensureWorldExists: mock.fn(() => Promise.resolve()),
    ensureRoomExists: mock.fn(() => Promise.resolve()),
    composeState: mock.fn(() => Promise.resolve({} as State)),
    useModel: mock.fn(() => Promise.resolve('mock response' as any)),
    registerModel: mock.fn(),
    getModel: mock.fn(() => undefined),
    registerEvent: mock.fn(),
    getEvent: mock.fn(() => undefined),
    emitEvent: mock.fn(() => Promise.resolve()),
    registerTaskWorker: mock.fn(),
    getTaskWorker: mock.fn(() => undefined),
    stop: mock.fn(() => Promise.resolve()),
    addEmbeddingToMemory: mock.fn((memory: Memory) => Promise.resolve(memory)),
    createRunId: mock.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    startRun: mock.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    endRun: mock.fn(),
    getCurrentRunId: mock.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    getEntityById: mock.fn(() => Promise.resolve(null)),
    getRoom: mock.fn(() => Promise.resolve(null)),
    createEntity: mock.fn(() => Promise.resolve(true)),
    createRoom: mock.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    addParticipant: mock.fn(() => Promise.resolve(true)),
    getRooms: mock.fn(() => Promise.resolve([])),
    registerSendHandler: mock.fn(),
    sendMessageToTarget: mock.fn(() => Promise.resolve()),

    // IDatabaseAdapter properties and methods
    db,
    isReady: mock.fn(() => Promise.resolve(true)),
    init: mock.fn(() => Promise.resolve()),
    runMigrations: mock.fn(() => Promise.resolve()),
    close: mock.fn(() => Promise.resolve()),
    getAgent: mock.fn(() => Promise.resolve(null)),
    getAgents: mock.fn(() => Promise.resolve([])),
    createAgent: mock.fn(() => Promise.resolve(true)),
    updateAgent: mock.fn(() => Promise.resolve(true)),
    deleteAgent: mock.fn(() => Promise.resolve(true)),
    ensureEmbeddingDimension: mock.fn(() => Promise.resolve()),
    getEntityByIds: mock.fn(() => Promise.resolve(null)),
    getEntitiesForRoom: mock.fn(() => Promise.resolve([])),
    createEntities: mock.fn(() => Promise.resolve(true)),
    updateEntity: mock.fn(() => Promise.resolve()),
    getComponent: mock.fn(() => Promise.resolve(null)),
    getComponents: mock.fn(() => Promise.resolve([])),
    createComponent: mock.fn(() => Promise.resolve(true)),
    updateComponent: mock.fn(() => Promise.resolve()),
    deleteComponent: mock.fn(() => Promise.resolve()),
    getMemories: mock.fn(() => Promise.resolve([])),
    getMemoryById: mock.fn(() => Promise.resolve(null)),
    getMemoriesByIds: mock.fn(() => Promise.resolve([])),
    getMemoriesByRoomIds: mock.fn(() => Promise.resolve([])),
    getCachedEmbeddings: mock.fn(() => Promise.resolve([])),
    log: mock.fn(() => Promise.resolve()),
    getLogs: mock.fn(() => Promise.resolve([])),
    deleteLog: mock.fn(() => Promise.resolve()),
    searchMemories: mock.fn(() => Promise.resolve([])),
    createMemory: mock.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    updateMemory: mock.fn(() => Promise.resolve(true)),
    deleteMemory: mock.fn(() => Promise.resolve()),
    deleteManyMemories: mock.fn(() => Promise.resolve()),
    deleteAllMemories: mock.fn(() => Promise.resolve()),
    countMemories: mock.fn(() => Promise.resolve(0)),
    createWorld: mock.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getWorld: mock.fn(() => Promise.resolve(null)),
    removeWorld: mock.fn(() => Promise.resolve()),
    getAllWorlds: mock.fn(() => Promise.resolve([])),
    updateWorld: mock.fn(() => Promise.resolve()),
    getRoomsByIds: mock.fn(() => Promise.resolve(null)),
    createRooms: mock.fn(() => Promise.resolve([])),
    deleteRoom: mock.fn(() => Promise.resolve()),
    deleteRoomsByWorldId: mock.fn(() => Promise.resolve()),
    updateRoom: mock.fn(() => Promise.resolve()),
    getRoomsForParticipant: mock.fn(() => Promise.resolve([])),
    getRoomsForParticipants: mock.fn(() => Promise.resolve([])),
    getRoomsByWorld: mock.fn(() => Promise.resolve([])),
    removeParticipant: mock.fn(() => Promise.resolve(true)),
    getParticipantsForEntity: mock.fn(() => Promise.resolve([])),
    getParticipantsForRoom: mock.fn(() => Promise.resolve([])),
    addParticipantsRoom: mock.fn(() => Promise.resolve(true)),
    getParticipantUserState: mock.fn(() => Promise.resolve(null)),
    setParticipantUserState: mock.fn(() => Promise.resolve()),
    createRelationship: mock.fn(() => Promise.resolve(true)),
    updateRelationship: mock.fn(() => Promise.resolve()),
    getRelationship: mock.fn(() => Promise.resolve(null)),
    getRelationships: mock.fn(() => Promise.resolve([])),
    getCache: mock.fn(() => Promise.resolve(undefined)),
    setCache: mock.fn(() => Promise.resolve(true)),
    deleteCache: mock.fn(() => Promise.resolve(true)),
    createTask: mock.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getTasks: mock.fn(() => Promise.resolve([])),
    getTask: mock.fn(() => Promise.resolve(null)),
    getTasksByName: mock.fn(() => Promise.resolve([])),
    updateTask: mock.fn(() => Promise.resolve()),
    deleteTask: mock.fn(() => Promise.resolve()),
    getMemoriesByWorldId: mock.fn(() => Promise.resolve([])),

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
    db: { execute: mock.fn(() => Promise.resolve([])) },
    init: mock.fn(() => Promise.resolve()),
    initialize: mock.fn(() => Promise.resolve()),
    isReady: mock.fn(() => Promise.resolve(true)),
    runMigrations: mock.fn(() => Promise.resolve()),
    close: mock.fn(() => Promise.resolve()),
    getConnection: mock.fn(() => Promise.resolve({ execute: mock.fn(() => Promise.resolve([])) })),

    // Agent methods
    getAgent: mock.fn(() => Promise.resolve(null)),
    getAgents: mock.fn(() => Promise.resolve([])),
    createAgent: mock.fn(() => Promise.resolve(true)),
    updateAgent: mock.fn(() => Promise.resolve(true)),
    deleteAgent: mock.fn(() => Promise.resolve(true)),

    // Entity methods
    getEntityByIds: mock.fn(() => Promise.resolve(null)),
    getEntitiesForRoom: mock.fn(() => Promise.resolve([])),
    createEntities: mock.fn(() => Promise.resolve(true)),
    updateEntity: mock.fn(() => Promise.resolve()),

    // Component methods
    getComponent: mock.fn(() => Promise.resolve(null)),
    getComponents: mock.fn(() => Promise.resolve([])),
    createComponent: mock.fn(() => Promise.resolve(true)),
    updateComponent: mock.fn(() => Promise.resolve()),
    deleteComponent: mock.fn(() => Promise.resolve()),

    // Memory methods
    getMemories: mock.fn(() => Promise.resolve([])),
    getMemoryById: mock.fn(() => Promise.resolve(null)),
    getMemoriesByIds: mock.fn(() => Promise.resolve([])),
    getMemoriesByRoomIds: mock.fn(() => Promise.resolve([])),
    getCachedEmbeddings: mock.fn(() => Promise.resolve([])),
    searchMemories: mock.fn(() => Promise.resolve([])),
    createMemory: mock.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    updateMemory: mock.fn(() => Promise.resolve(true)),
    deleteMemory: mock.fn(() => Promise.resolve()),
    deleteManyMemories: mock.fn(() => Promise.resolve()),
    deleteAllMemories: mock.fn(() => Promise.resolve()),
    countMemories: mock.fn(() => Promise.resolve(0)),
    getMemoriesByWorldId: mock.fn(() => Promise.resolve([])),
    ensureEmbeddingDimension: mock.fn(() => Promise.resolve()),

    // Log methods
    log: mock.fn(() => Promise.resolve()),
    getLogs: mock.fn(() => Promise.resolve([])),
    deleteLog: mock.fn(() => Promise.resolve()),

    // World methods
    createWorld: mock.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getWorld: mock.fn(() => Promise.resolve(null)),
    removeWorld: mock.fn(() => Promise.resolve()),
    getAllWorlds: mock.fn(() => Promise.resolve([])),
    updateWorld: mock.fn(() => Promise.resolve()),

    // Room methods
    getRoomsByIds: mock.fn(() => Promise.resolve(null)),
    createRooms: mock.fn(() => Promise.resolve([])),
    deleteRoom: mock.fn(() => Promise.resolve()),
    deleteRoomsByWorldId: mock.fn(() => Promise.resolve()),
    updateRoom: mock.fn(() => Promise.resolve()),
    getRoomsForParticipant: mock.fn(() => Promise.resolve([])),
    getRoomsForParticipants: mock.fn(() => Promise.resolve([])),
    getRoomsByWorld: mock.fn(() => Promise.resolve([])),

    // Participant methods
    removeParticipant: mock.fn(() => Promise.resolve(true)),
    getParticipantsForEntity: mock.fn(() => Promise.resolve([])),
    getParticipantsForRoom: mock.fn(() => Promise.resolve([])),
    addParticipantsRoom: mock.fn(() => Promise.resolve(true)),
    getParticipantUserState: mock.fn(() => Promise.resolve(null)),
    setParticipantUserState: mock.fn(() => Promise.resolve()),

    // Relationship methods
    createRelationship: mock.fn(() => Promise.resolve(true)),
    updateRelationship: mock.fn(() => Promise.resolve()),
    getRelationship: mock.fn(() => Promise.resolve(null)),
    getRelationships: mock.fn(() => Promise.resolve([])),

    // Cache methods
    getCache: mock.fn(() => Promise.resolve(undefined)),
    setCache: mock.fn(() => Promise.resolve(true)),
    deleteCache: mock.fn(() => Promise.resolve(true)),

    // Task methods
    createTask: mock.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getTasks: mock.fn(() => Promise.resolve([])),
    getTask: mock.fn(() => Promise.resolve(null)),
    getTasksByName: mock.fn(() => Promise.resolve([])),
    updateTask: mock.fn(() => Promise.resolve()),
    deleteTask: mock.fn(() => Promise.resolve()),

    // Message server methods (for AgentServer tests)
    createMessageServer: mock.fn(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' })
    ),
    getMessageServers: mock.fn(() =>
      Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }])
    ),
    getMessageServerById: mock.fn(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' })
    ),
    addAgentToServer: mock.fn(() => Promise.resolve()),
    removeAgentFromServer: mock.fn(() => Promise.resolve()),
    getAgentsForServer: mock.fn(() => Promise.resolve([])),

    // Channel methods
    createChannel: mock.fn(() => Promise.resolve({ id: '123e4567-e89b-12d3-a456-426614174000' })),
    getChannelsForServer: mock.fn(() => Promise.resolve([])),
    getChannelDetails: mock.fn(() => Promise.resolve(null)),
    getChannelParticipants: mock.fn(() => Promise.resolve([])),
    addChannelParticipants: mock.fn(() => Promise.resolve()),
    updateChannel: mock.fn(() => Promise.resolve()),
    deleteChannel: mock.fn(() => Promise.resolve()),

    // Message methods
    createMessage: mock.fn(() => Promise.resolve({ id: 'message-id' })),
    getMessagesForChannel: mock.fn(() => Promise.resolve([])),
    deleteMessage: mock.fn(() => Promise.resolve()),

    // DM methods
    findOrCreateDmChannel: mock.fn(() => Promise.resolve({ id: 'dm-channel-id' })),

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
    get: mock.fn((header: string) => ''),
    header: mock.fn((header: string) => ''),
    accepts: mock.fn(),
    acceptsCharsets: mock.fn(),
    acceptsEncodings: mock.fn(),
    acceptsLanguages: mock.fn(),
    is: mock.fn(),
    ...overrides,
  } as any;
}

/**
 * Creates a mock Express Response
 */
export function createMockResponse(): Response {
  const res = {
    status: mock.fn().mockReturnThis(),
    json: mock.fn().mockReturnThis(),
    send: mock.fn().mockReturnThis(),
    end: mock.fn().mockReturnThis(),
    setHeader: mock.fn().mockReturnThis(),
    removeHeader: mock.fn().mockReturnThis(),
    set: mock.fn().mockReturnThis(),
    header: mock.fn().mockReturnThis(),
    type: mock.fn().mockReturnThis(),
    sendStatus: mock.fn().mockReturnThis(),
    redirect: mock.fn().mockReturnThis(),
    cookie: mock.fn().mockReturnThis(),
    clearCookie: mock.fn().mockReturnThis(),
    attachment: mock.fn().mockReturnThis(),
    sendFile: mock.fn((path: string, options?: any, callback?: any) => {
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
  return mock.fn() as any;
}

/**
 * Creates a mock Socket.IO Server
 */
export function createMockSocketIO() {
  return {
    on: mock.fn(),
    emit: mock.fn(),
    to: mock.fn(() => ({
      emit: mock.fn(),
    })),
    sockets: {
      sockets: new Map(),
    },
    close: mock.fn((callback?: () => void) => {
      if (callback) callback();
    }),
  };
}

/**
 * Creates a mock HTTP Server
 */
export function createMockHttpServer() {
  return {
    listen: mock.fn((port: number, callback?: () => void) => {
      if (callback) callback();
    }),
    close: mock.fn((callback?: () => void) => {
      if (callback) callback();
    }),
    listeners: mock.fn(() => []),
    removeAllListeners: mock.fn(),
    on: mock.fn(),
    once: mock.fn(),
    emit: mock.fn(),
    address: mock.fn(() => ({ port: 3000 })),
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
    getInstance: mock.fn(),
    start: mock.fn(() => Promise.resolve()),
    stop: mock.fn(() => Promise.resolve()),
    ...overrides,
  } as any;
}

/**
 * Creates mock express-fileupload file
 */
export function createMockUploadedFile(overrides?: Partial<any>): any {
  return {
    name: 'test.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    data: Buffer.from('test'),
    tempFilePath: '/tmp/upload_123456',
    size: 12345,
    truncated: false,
    md5: 'abc123',
    mv: mock.fn((path: string) => Promise.resolve()),
    ...overrides,
  };
}
