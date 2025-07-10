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
import { mock, jest } from 'bun:test';

/**
 * Creates a mock IAgentRuntime with all required properties
 */
export function createMockAgentRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
  const db = { execute: jest.fn(() => Promise.resolve([])) };

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
    registerPlugin: jest.fn(() => Promise.resolve()),
    initialize: jest.fn(() => Promise.resolve()),
    getConnection: jest.fn(() => Promise.resolve(db)),
    getService: jest.fn(() => null),
    getAllServices: jest.fn(() => new Map()),
    registerService: jest.fn(() => Promise.resolve()),
    registerDatabaseAdapter: jest.fn(),
    setSetting: jest.fn(),
    getSetting: jest.fn((key: string) => overrides?.character?.settings?.[key]),
    getConversationLength: jest.fn(() => 10),
    processActions: jest.fn(() => Promise.resolve()),
    evaluate: jest.fn(() => Promise.resolve([] as Evaluator[])),
    registerProvider: jest.fn(),
    registerAction: jest.fn(),
    registerEvaluator: jest.fn(),
    ensureConnections: jest.fn(() => Promise.resolve()),
    ensureConnection: jest.fn(() => Promise.resolve()),
    ensureParticipantInRoom: jest.fn(() => Promise.resolve()),
    ensureWorldExists: jest.fn(() => Promise.resolve()),
    ensureRoomExists: jest.fn(() => Promise.resolve()),
    composeState: jest.fn(() => Promise.resolve({} as State)),
    useModel: jest.fn(() => Promise.resolve('mock response' as any)),
    registerModel: jest.fn(),
    getModel: jest.fn(() => undefined),
    registerEvent: jest.fn(),
    getEvent: jest.fn(() => undefined),
    emitEvent: jest.fn(() => Promise.resolve()),
    registerTaskWorker: jest.fn(),
    getTaskWorker: jest.fn(() => undefined),
    stop: jest.fn(() => Promise.resolve()),
    addEmbeddingToMemory: jest.fn((memory: Memory) => Promise.resolve(memory)),
    createRunId: jest.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    startRun: jest.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    endRun: jest.fn(),
    getCurrentRunId: jest.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    getEntityById: jest.fn(() => Promise.resolve(null)),
    getRoom: jest.fn(() => Promise.resolve(null)),
    createEntity: jest.fn(() => Promise.resolve(true)),
    createRoom: jest.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    addParticipant: jest.fn(() => Promise.resolve(true)),
    getRooms: jest.fn(() => Promise.resolve([])),
    registerSendHandler: jest.fn(),
    sendMessageToTarget: jest.fn(() => Promise.resolve()),

    // IDatabaseAdapter properties and methods
    db,
    isReady: jest.fn(() => Promise.resolve(true)),
    init: jest.fn(() => Promise.resolve()),
    runMigrations: jest.fn(() => Promise.resolve()),
    close: jest.fn(() => Promise.resolve()),
    getAgent: jest.fn(() => Promise.resolve(null)),
    getAgents: jest.fn(() => Promise.resolve([])),
    createAgent: jest.fn(() => Promise.resolve(true)),
    updateAgent: jest.fn(() => Promise.resolve(true)),
    deleteAgent: jest.fn(() => Promise.resolve(true)),
    ensureEmbeddingDimension: jest.fn(() => Promise.resolve()),
    getEntityByIds: jest.fn(() => Promise.resolve(null)),
    getEntitiesForRoom: jest.fn(() => Promise.resolve([])),
    createEntities: jest.fn(() => Promise.resolve(true)),
    updateEntity: jest.fn(() => Promise.resolve()),
    getComponent: jest.fn(() => Promise.resolve(null)),
    getComponents: jest.fn(() => Promise.resolve([])),
    createComponent: jest.fn(() => Promise.resolve(true)),
    updateComponent: jest.fn(() => Promise.resolve()),
    deleteComponent: jest.fn(() => Promise.resolve()),
    getMemories: jest.fn(() => Promise.resolve([])),
    getAllMemories: jest.fn(() => Promise.resolve([])),
    clearAllAgentMemories: jest.fn(() => Promise.resolve()),
    getMemoryById: jest.fn(() => Promise.resolve(null)),
    getMemoriesByIds: jest.fn(() => Promise.resolve([])),
    getMemoriesByRoomIds: jest.fn(() => Promise.resolve([])),
    getCachedEmbeddings: jest.fn(() => Promise.resolve([])),
    log: jest.fn(() => Promise.resolve()),
    getLogs: jest.fn(() => Promise.resolve([])),
    deleteLog: jest.fn(() => Promise.resolve()),
    searchMemories: jest.fn(() => Promise.resolve([])),
    createMemory: jest.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    updateMemory: jest.fn(() => Promise.resolve(true)),
    deleteMemory: jest.fn(() => Promise.resolve()),
    deleteManyMemories: jest.fn(() => Promise.resolve()),
    deleteAllMemories: jest.fn(() => Promise.resolve()),
    countMemories: jest.fn(() => Promise.resolve(0)),
    createWorld: jest.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getWorld: jest.fn(() => Promise.resolve(null)),
    removeWorld: jest.fn(() => Promise.resolve()),
    getAllWorlds: jest.fn(() => Promise.resolve([])),
    updateWorld: jest.fn(() => Promise.resolve()),
    getRoomsByIds: jest.fn(() => Promise.resolve(null)),
    createRooms: jest.fn(() => Promise.resolve([])),
    deleteRoom: jest.fn(() => Promise.resolve()),
    deleteRoomsByWorldId: jest.fn(() => Promise.resolve()),
    updateRoom: jest.fn(() => Promise.resolve()),
    getRoomsForParticipant: jest.fn(() => Promise.resolve([])),
    getRoomsForParticipants: jest.fn(() => Promise.resolve([])),
    getRoomsByWorld: jest.fn(() => Promise.resolve([])),
    removeParticipant: jest.fn(() => Promise.resolve(true)),
    getParticipantsForEntity: jest.fn(() => Promise.resolve([])),
    getParticipantsForRoom: jest.fn(() => Promise.resolve([])),
    addParticipantsRoom: jest.fn(() => Promise.resolve(true)),
    getParticipantUserState: jest.fn(() => Promise.resolve(null)),
    setParticipantUserState: jest.fn(() => Promise.resolve()),
    createRelationship: jest.fn(() => Promise.resolve(true)),
    updateRelationship: jest.fn(() => Promise.resolve()),
    getRelationship: jest.fn(() => Promise.resolve(null)),
    getRelationships: jest.fn(() => Promise.resolve([])),
    getCache: jest.fn(() => Promise.resolve(undefined)),
    setCache: jest.fn(() => Promise.resolve(true)),
    deleteCache: jest.fn(() => Promise.resolve(true)),
    createTask: jest.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getTasks: jest.fn(() => Promise.resolve([])),
    getTask: jest.fn(() => Promise.resolve(null)),
    getTasksByName: jest.fn(() => Promise.resolve([])),
    updateTask: jest.fn(() => Promise.resolve()),
    deleteTask: jest.fn(() => Promise.resolve()),
    getMemoriesByWorldId: jest.fn(() => Promise.resolve([])),

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
    db: { execute: jest.fn(() => Promise.resolve([])) },
    init: jest.fn(() => Promise.resolve()),
    initialize: jest.fn(() => Promise.resolve()),
    isReady: jest.fn(() => Promise.resolve(true)),
    runMigrations: jest.fn(() => Promise.resolve()),
    close: jest.fn(() => Promise.resolve()),
    getConnection: jest.fn(() => Promise.resolve({ execute: jest.fn(() => Promise.resolve([])) })),

    // Agent methods
    getAgent: jest.fn(() => Promise.resolve(null)),
    getAgents: jest.fn(() => Promise.resolve([])),
    createAgent: jest.fn(() => Promise.resolve(true)),
    updateAgent: jest.fn(() => Promise.resolve(true)),
    deleteAgent: jest.fn(() => Promise.resolve(true)),

    // Entity methods
    getEntityByIds: jest.fn(() => Promise.resolve(null)),
    getEntitiesForRoom: jest.fn(() => Promise.resolve([])),
    createEntities: jest.fn(() => Promise.resolve(true)),
    updateEntity: jest.fn(() => Promise.resolve()),

    // Component methods
    getComponent: jest.fn(() => Promise.resolve(null)),
    getComponents: jest.fn(() => Promise.resolve([])),
    createComponent: jest.fn(() => Promise.resolve(true)),
    updateComponent: jest.fn(() => Promise.resolve()),
    deleteComponent: jest.fn(() => Promise.resolve()),

    // Memory methods
    getMemories: jest.fn(() => Promise.resolve([])),
    getMemoryById: jest.fn(() => Promise.resolve(null)),
    getMemoriesByIds: jest.fn(() => Promise.resolve([])),
    getMemoriesByRoomIds: jest.fn(() => Promise.resolve([])),
    getCachedEmbeddings: jest.fn(() => Promise.resolve([])),
    searchMemories: jest.fn(() => Promise.resolve([])),
    createMemory: jest.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    updateMemory: jest.fn(() => Promise.resolve(true)),
    deleteMemory: jest.fn(() => Promise.resolve()),
    deleteManyMemories: jest.fn(() => Promise.resolve()),
    deleteAllMemories: jest.fn(() => Promise.resolve()),
    countMemories: jest.fn(() => Promise.resolve(0)),
    getMemoriesByWorldId: jest.fn(() => Promise.resolve([])),
    ensureEmbeddingDimension: jest.fn(() => Promise.resolve()),

    // Log methods
    log: jest.fn(() => Promise.resolve()),
    getLogs: jest.fn(() => Promise.resolve([])),
    deleteLog: jest.fn(() => Promise.resolve()),

    // World methods
    createWorld: jest.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getWorld: jest.fn(() => Promise.resolve(null)),
    removeWorld: jest.fn(() => Promise.resolve()),
    getAllWorlds: jest.fn(() => Promise.resolve([])),
    updateWorld: jest.fn(() => Promise.resolve()),

    // Room methods
    getRoomsByIds: jest.fn(() => Promise.resolve(null)),
    createRooms: jest.fn(() => Promise.resolve([])),
    deleteRoom: jest.fn(() => Promise.resolve()),
    deleteRoomsByWorldId: jest.fn(() => Promise.resolve()),
    updateRoom: jest.fn(() => Promise.resolve()),
    getRoomsForParticipant: jest.fn(() => Promise.resolve([])),
    getRoomsForParticipants: jest.fn(() => Promise.resolve([])),
    getRoomsByWorld: jest.fn(() => Promise.resolve([])),

    // Participant methods
    removeParticipant: jest.fn(() => Promise.resolve(true)),
    getParticipantsForEntity: jest.fn(() => Promise.resolve([])),
    getParticipantsForRoom: jest.fn(() => Promise.resolve([])),
    addParticipantsRoom: jest.fn(() => Promise.resolve(true)),
    getParticipantUserState: jest.fn(() => Promise.resolve(null)),
    setParticipantUserState: jest.fn(() => Promise.resolve()),

    // Relationship methods
    createRelationship: jest.fn(() => Promise.resolve(true)),
    updateRelationship: jest.fn(() => Promise.resolve()),
    getRelationship: jest.fn(() => Promise.resolve(null)),
    getRelationships: jest.fn(() => Promise.resolve([])),

    // Cache methods
    getCache: jest.fn(() => Promise.resolve(undefined)),
    setCache: jest.fn(() => Promise.resolve(true)),
    deleteCache: jest.fn(() => Promise.resolve(true)),

    // Task methods
    createTask: jest.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getTasks: jest.fn(() => Promise.resolve([])),
    getTask: jest.fn(() => Promise.resolve(null)),
    getTasksByName: jest.fn(() => Promise.resolve([])),
    updateTask: jest.fn(() => Promise.resolve()),
    deleteTask: jest.fn(() => Promise.resolve()),

    // Message server methods (for AgentServer tests)
    createMessageServer: jest.fn(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' })
    ),
    getMessageServers: jest.fn(() =>
      Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }])
    ),
    getMessageServerById: jest.fn(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' })
    ),
    addAgentToServer: jest.fn(() => Promise.resolve()),
    removeAgentFromServer: jest.fn(() => Promise.resolve()),
    getAgentsForServer: jest.fn(() => Promise.resolve([])),

    // Channel methods
    createChannel: jest.fn(() => Promise.resolve({ id: '123e4567-e89b-12d3-a456-426614174000' })),
    getChannelsForServer: jest.fn(() => Promise.resolve([])),
    getChannelDetails: jest.fn(() => Promise.resolve(null)),
    getChannelParticipants: jest.fn(() => Promise.resolve([])),
    addChannelParticipants: jest.fn(() => Promise.resolve()),
    updateChannel: jest.fn(() => Promise.resolve()),
    deleteChannel: jest.fn(() => Promise.resolve()),

    // Message methods
    createMessage: jest.fn(() => Promise.resolve({ id: 'message-id' })),
    getMessagesForChannel: jest.fn(() => Promise.resolve([])),
    deleteMessage: jest.fn(() => Promise.resolve()),

    // DM methods
    findOrCreateDmChannel: jest.fn(() => Promise.resolve({ id: 'dm-channel-id' })),

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
    get: jest.fn((_header: string) => ''),
    header: jest.fn((_header: string) => ''),
    accepts: jest.fn(),
    acceptsCharsets: jest.fn(),
    acceptsEncodings: jest.fn(),
    acceptsLanguages: jest.fn(),
    is: jest.fn(),
    ...overrides,
  } as any;
}

/**
 * Creates a mock Express Response
 */
export function createMockResponse(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    removeHeader: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    header: jest.fn().mockReturnThis(),
    type: jest.fn().mockReturnThis(),
    sendStatus: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
    cookie: jest.fn().mockReturnThis(),
    clearCookie: jest.fn().mockReturnThis(),
    attachment: jest.fn().mockReturnThis(),
    sendFile: jest.fn((_path: string, options?: any, callback?: any) => {
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
  return jest.fn() as any;
}

/**
 * Creates a mock Socket.IO Server
 */
export function createMockSocketIO() {
  return {
    on: jest.fn(),
    emit: jest.fn(),
    to: jest.fn(() => ({
      emit: jest.fn(),
    })),
    sockets: {
      sockets: new Map(),
    },
    close: jest.fn((callback?: () => void) => {
      if (callback) callback();
    }),
  };
}

/**
 * Creates a mock HTTP Server
 */
export function createMockHttpServer() {
  return {
    listen: jest.fn((_port: number, callback?: () => void) => {
      if (callback) callback();
    }),
    close: jest.fn((callback?: () => void) => {
      if (callback) callback();
    }),
    listeners: jest.fn(() => []),
    removeAllListeners: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    emit: jest.fn(),
    address: jest.fn(() => ({ port: 3000 })),
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
    getInstance: jest.fn(),
    start: jest.fn(() => Promise.resolve()),
    stop: jest.fn(() => Promise.resolve()),
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
