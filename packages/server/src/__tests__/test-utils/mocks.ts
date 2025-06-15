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
import { vi } from 'vitest';

/**
 * Creates a mock IAgentRuntime with all required properties
 */
export function createMockAgentRuntime(overrides?: Partial<IAgentRuntime>): IAgentRuntime {
  const db = { execute: vi.fn(() => Promise.resolve([])) };

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
    registerPlugin: vi.fn(() => Promise.resolve()),
    initialize: vi.fn(() => Promise.resolve()),
    getConnection: vi.fn(() => Promise.resolve(db)),
    getService: vi.fn(() => null),
    getAllServices: vi.fn(() => new Map()),
    registerService: vi.fn(() => Promise.resolve()),
    registerDatabaseAdapter: vi.fn(),
    setSetting: vi.fn(),
    getSetting: vi.fn((key: string) => overrides?.character?.settings?.[key]),
    getConversationLength: vi.fn(() => 10),
    processActions: vi.fn(() => Promise.resolve()),
    evaluate: vi.fn(() => Promise.resolve([] as Evaluator[])),
    registerProvider: vi.fn(),
    registerAction: vi.fn(),
    registerEvaluator: vi.fn(),
    ensureConnections: vi.fn(() => Promise.resolve()),
    ensureConnection: vi.fn(() => Promise.resolve()),
    ensureParticipantInRoom: vi.fn(() => Promise.resolve()),
    ensureWorldExists: vi.fn(() => Promise.resolve()),
    ensureRoomExists: vi.fn(() => Promise.resolve()),
    composeState: vi.fn(() => Promise.resolve({} as State)),
    useModel: vi.fn(() => Promise.resolve('mock response' as any)),
    registerModel: vi.fn(),
    getModel: vi.fn(() => undefined),
    registerEvent: vi.fn(),
    getEvent: vi.fn(() => undefined),
    emitEvent: vi.fn(() => Promise.resolve()),
    registerTaskWorker: vi.fn(),
    getTaskWorker: vi.fn(() => undefined),
    stop: vi.fn(() => Promise.resolve()),
    addEmbeddingToMemory: vi.fn((memory: Memory) => Promise.resolve(memory)),
    createRunId: vi.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    startRun: vi.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    endRun: vi.fn(),
    getCurrentRunId: vi.fn(() => '123e4567-e89b-12d3-a456-426614174000' as UUID),
    getEntityById: vi.fn(() => Promise.resolve(null)),
    getRoom: vi.fn(() => Promise.resolve(null)),
    createEntity: vi.fn(() => Promise.resolve(true)),
    createRoom: vi.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    addParticipant: vi.fn(() => Promise.resolve(true)),
    getRooms: vi.fn(() => Promise.resolve([])),
    registerSendHandler: vi.fn(),
    sendMessageToTarget: vi.fn(() => Promise.resolve()),

    // IDatabaseAdapter properties and methods
    db,
    isReady: vi.fn(() => Promise.resolve(true)),
    init: vi.fn(() => Promise.resolve()),
    runMigrations: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    getAgent: vi.fn(() => Promise.resolve(null)),
    getAgents: vi.fn(() => Promise.resolve([])),
    createAgent: vi.fn(() => Promise.resolve(true)),
    updateAgent: vi.fn(() => Promise.resolve(true)),
    deleteAgent: vi.fn(() => Promise.resolve(true)),
    ensureEmbeddingDimension: vi.fn(() => Promise.resolve()),
    getEntityByIds: vi.fn(() => Promise.resolve(null)),
    getEntitiesForRoom: vi.fn(() => Promise.resolve([])),
    createEntities: vi.fn(() => Promise.resolve(true)),
    updateEntity: vi.fn(() => Promise.resolve()),
    getComponent: vi.fn(() => Promise.resolve(null)),
    getComponents: vi.fn(() => Promise.resolve([])),
    createComponent: vi.fn(() => Promise.resolve(true)),
    updateComponent: vi.fn(() => Promise.resolve()),
    deleteComponent: vi.fn(() => Promise.resolve()),
    getMemories: vi.fn(() => Promise.resolve([])),
    getMemoryById: vi.fn(() => Promise.resolve(null)),
    getMemoriesByIds: vi.fn(() => Promise.resolve([])),
    getMemoriesByRoomIds: vi.fn(() => Promise.resolve([])),
    getCachedEmbeddings: vi.fn(() => Promise.resolve([])),
    log: vi.fn(() => Promise.resolve()),
    getLogs: vi.fn(() => Promise.resolve([])),
    deleteLog: vi.fn(() => Promise.resolve()),
    searchMemories: vi.fn(() => Promise.resolve([])),
    createMemory: vi.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    updateMemory: vi.fn(() => Promise.resolve(true)),
    deleteMemory: vi.fn(() => Promise.resolve()),
    deleteManyMemories: vi.fn(() => Promise.resolve()),
    deleteAllMemories: vi.fn(() => Promise.resolve()),
    countMemories: vi.fn(() => Promise.resolve(0)),
    createWorld: vi.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getWorld: vi.fn(() => Promise.resolve(null)),
    removeWorld: vi.fn(() => Promise.resolve()),
    getAllWorlds: vi.fn(() => Promise.resolve([])),
    updateWorld: vi.fn(() => Promise.resolve()),
    getRoomsByIds: vi.fn(() => Promise.resolve(null)),
    createRooms: vi.fn(() => Promise.resolve([])),
    deleteRoom: vi.fn(() => Promise.resolve()),
    deleteRoomsByWorldId: vi.fn(() => Promise.resolve()),
    updateRoom: vi.fn(() => Promise.resolve()),
    getRoomsForParticipant: vi.fn(() => Promise.resolve([])),
    getRoomsForParticipants: vi.fn(() => Promise.resolve([])),
    getRoomsByWorld: vi.fn(() => Promise.resolve([])),
    removeParticipant: vi.fn(() => Promise.resolve(true)),
    getParticipantsForEntity: vi.fn(() => Promise.resolve([])),
    getParticipantsForRoom: vi.fn(() => Promise.resolve([])),
    addParticipantsRoom: vi.fn(() => Promise.resolve(true)),
    getParticipantUserState: vi.fn(() => Promise.resolve(null)),
    setParticipantUserState: vi.fn(() => Promise.resolve()),
    createRelationship: vi.fn(() => Promise.resolve(true)),
    updateRelationship: vi.fn(() => Promise.resolve()),
    getRelationship: vi.fn(() => Promise.resolve(null)),
    getRelationships: vi.fn(() => Promise.resolve([])),
    getCache: vi.fn(() => Promise.resolve(undefined)),
    setCache: vi.fn(() => Promise.resolve(true)),
    deleteCache: vi.fn(() => Promise.resolve(true)),
    createTask: vi.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getTasks: vi.fn(() => Promise.resolve([])),
    getTask: vi.fn(() => Promise.resolve(null)),
    getTasksByName: vi.fn(() => Promise.resolve([])),
    updateTask: vi.fn(() => Promise.resolve()),
    deleteTask: vi.fn(() => Promise.resolve()),
    getMemoriesByWorldId: vi.fn(() => Promise.resolve([])),

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
    db: { execute: vi.fn(() => Promise.resolve([])) },
    init: vi.fn(() => Promise.resolve()),
    initialize: vi.fn(() => Promise.resolve()),
    isReady: vi.fn(() => Promise.resolve(true)),
    runMigrations: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    getConnection: vi.fn(() => Promise.resolve({ execute: vi.fn(() => Promise.resolve([])) })),

    // Agent methods
    getAgent: vi.fn(() => Promise.resolve(null)),
    getAgents: vi.fn(() => Promise.resolve([])),
    createAgent: vi.fn(() => Promise.resolve(true)),
    updateAgent: vi.fn(() => Promise.resolve(true)),
    deleteAgent: vi.fn(() => Promise.resolve(true)),

    // Entity methods
    getEntityByIds: vi.fn(() => Promise.resolve(null)),
    getEntitiesForRoom: vi.fn(() => Promise.resolve([])),
    createEntities: vi.fn(() => Promise.resolve(true)),
    updateEntity: vi.fn(() => Promise.resolve()),

    // Component methods
    getComponent: vi.fn(() => Promise.resolve(null)),
    getComponents: vi.fn(() => Promise.resolve([])),
    createComponent: vi.fn(() => Promise.resolve(true)),
    updateComponent: vi.fn(() => Promise.resolve()),
    deleteComponent: vi.fn(() => Promise.resolve()),

    // Memory methods
    getMemories: vi.fn(() => Promise.resolve([])),
    getMemoryById: vi.fn(() => Promise.resolve(null)),
    getMemoriesByIds: vi.fn(() => Promise.resolve([])),
    getMemoriesByRoomIds: vi.fn(() => Promise.resolve([])),
    getCachedEmbeddings: vi.fn(() => Promise.resolve([])),
    searchMemories: vi.fn(() => Promise.resolve([])),
    createMemory: vi.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    updateMemory: vi.fn(() => Promise.resolve(true)),
    deleteMemory: vi.fn(() => Promise.resolve()),
    deleteManyMemories: vi.fn(() => Promise.resolve()),
    deleteAllMemories: vi.fn(() => Promise.resolve()),
    countMemories: vi.fn(() => Promise.resolve(0)),
    getMemoriesByWorldId: vi.fn(() => Promise.resolve([])),
    ensureEmbeddingDimension: vi.fn(() => Promise.resolve()),

    // Log methods
    log: vi.fn(() => Promise.resolve()),
    getLogs: vi.fn(() => Promise.resolve([])),
    deleteLog: vi.fn(() => Promise.resolve()),

    // World methods
    createWorld: vi.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getWorld: vi.fn(() => Promise.resolve(null)),
    removeWorld: vi.fn(() => Promise.resolve()),
    getAllWorlds: vi.fn(() => Promise.resolve([])),
    updateWorld: vi.fn(() => Promise.resolve()),

    // Room methods
    getRoomsByIds: vi.fn(() => Promise.resolve(null)),
    createRooms: vi.fn(() => Promise.resolve([])),
    deleteRoom: vi.fn(() => Promise.resolve()),
    deleteRoomsByWorldId: vi.fn(() => Promise.resolve()),
    updateRoom: vi.fn(() => Promise.resolve()),
    getRoomsForParticipant: vi.fn(() => Promise.resolve([])),
    getRoomsForParticipants: vi.fn(() => Promise.resolve([])),
    getRoomsByWorld: vi.fn(() => Promise.resolve([])),

    // Participant methods
    removeParticipant: vi.fn(() => Promise.resolve(true)),
    getParticipantsForEntity: vi.fn(() => Promise.resolve([])),
    getParticipantsForRoom: vi.fn(() => Promise.resolve([])),
    addParticipantsRoom: vi.fn(() => Promise.resolve(true)),
    getParticipantUserState: vi.fn(() => Promise.resolve(null)),
    setParticipantUserState: vi.fn(() => Promise.resolve()),

    // Relationship methods
    createRelationship: vi.fn(() => Promise.resolve(true)),
    updateRelationship: vi.fn(() => Promise.resolve()),
    getRelationship: vi.fn(() => Promise.resolve(null)),
    getRelationships: vi.fn(() => Promise.resolve([])),

    // Cache methods
    getCache: vi.fn(() => Promise.resolve(undefined)),
    setCache: vi.fn(() => Promise.resolve(true)),
    deleteCache: vi.fn(() => Promise.resolve(true)),

    // Task methods
    createTask: vi.fn(() => Promise.resolve('123e4567-e89b-12d3-a456-426614174000' as UUID)),
    getTasks: vi.fn(() => Promise.resolve([])),
    getTask: vi.fn(() => Promise.resolve(null)),
    getTasksByName: vi.fn(() => Promise.resolve([])),
    updateTask: vi.fn(() => Promise.resolve()),
    deleteTask: vi.fn(() => Promise.resolve()),

    // Message server methods (for AgentServer tests)
    createMessageServer: vi.fn(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' })
    ),
    getMessageServers: vi.fn(() =>
      Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }])
    ),
    getMessageServerById: vi.fn(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' })
    ),
    addAgentToServer: vi.fn(() => Promise.resolve()),
    removeAgentFromServer: vi.fn(() => Promise.resolve()),
    getAgentsForServer: vi.fn(() => Promise.resolve([])),

    // Channel methods
    createChannel: vi.fn(() => Promise.resolve({ id: '123e4567-e89b-12d3-a456-426614174000' })),
    getChannelsForServer: vi.fn(() => Promise.resolve([])),
    getChannelDetails: vi.fn(() => Promise.resolve(null)),
    getChannelParticipants: vi.fn(() => Promise.resolve([])),
    addChannelParticipants: vi.fn(() => Promise.resolve()),
    updateChannel: vi.fn(() => Promise.resolve()),
    deleteChannel: vi.fn(() => Promise.resolve()),

    // Message methods
    createMessage: vi.fn(() => Promise.resolve({ id: 'message-id' })),
    getMessagesForChannel: vi.fn(() => Promise.resolve([])),
    deleteMessage: vi.fn(() => Promise.resolve()),

    // DM methods
    findOrCreateDmChannel: vi.fn(() => Promise.resolve({ id: 'dm-channel-id' })),

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
    get: vi.fn((header: string) => ''),
    header: vi.fn((header: string) => ''),
    accepts: vi.fn(),
    acceptsCharsets: vi.fn(),
    acceptsEncodings: vi.fn(),
    acceptsLanguages: vi.fn(),
    is: vi.fn(),
    ...overrides,
  } as any;
}

/**
 * Creates a mock Express Response
 */
export function createMockResponse(): Response {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
    removeHeader: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    header: vi.fn().mockReturnThis(),
    type: vi.fn().mockReturnThis(),
    sendStatus: vi.fn().mockReturnThis(),
    redirect: vi.fn().mockReturnThis(),
    cookie: vi.fn().mockReturnThis(),
    clearCookie: vi.fn().mockReturnThis(),
    attachment: vi.fn().mockReturnThis(),
    sendFile: vi.fn((path: string, options?: any, callback?: any) => {
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
  return vi.fn() as any;
}

/**
 * Creates a mock Socket.IO Server
 */
export function createMockSocketIO() {
  return {
    on: vi.fn(),
    emit: vi.fn(),
    to: vi.fn(() => ({
      emit: vi.fn(),
    })),
    sockets: {
      sockets: new Map(),
    },
    close: vi.fn((callback?: () => void) => {
      if (callback) callback();
    }),
  };
}

/**
 * Creates a mock HTTP Server
 */
export function createMockHttpServer() {
  return {
    listen: vi.fn((port: number, callback?: () => void) => {
      if (callback) callback();
    }),
    close: vi.fn((callback?: () => void) => {
      if (callback) callback();
    }),
    listeners: vi.fn(() => []),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    address: vi.fn(() => ({ port: 3000 })),
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
    getInstance: vi.fn(),
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    ...overrides,
  } as any;
}

/**
 * Creates mock multer file
 */
export function createMockMulterFile(
  overrides?: Partial<Express.Multer.File>
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'test.jpg',
    encoding: '7bit',
    mimetype: 'image/jpeg',
    destination: '/tmp/uploads',
    filename: 'test-123.jpg',
    path: '/tmp/uploads/test-123.jpg',
    size: 12345,
    stream: null as any,
    buffer: Buffer.from('test'),
    ...overrides,
  };
}
