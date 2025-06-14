/**
 * API endpoint basic tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { AgentServer } from '../src/index';

// Mock dependencies
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
    },
    Service: class MockService {
      constructor() {}
      async initialize() {}
      async cleanup() {}
    },
    createUniqueUuid: vi.fn(() => '123e4567-e89b-12d3-a456-426614174000'),
    ChannelType: {
      DIRECT: 'direct',
      GROUP: 'group',
    },
    EventType: {
      MESSAGE: 'message',
      USER_JOIN: 'user_join',
    },
    SOCKET_MESSAGE_TYPE: {
      MESSAGE: 'message',
      AGENT_UPDATE: 'agent_update',
      CONNECTION: 'connection',
    },
  };
});

vi.mock('@elizaos/plugin-sql', () => ({
  createDatabaseAdapter: vi.fn(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    getDatabase: vi.fn(() => ({
      execute: vi.fn().mockResolvedValue([]),
    })),
    getMessageServers: vi.fn().mockResolvedValue([
      { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }
    ]),
    createMessageServer: vi.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000' }),
    getAgentsForServer: vi.fn().mockResolvedValue([]),
    addAgentToServer: vi.fn().mockResolvedValue(undefined),
    db: { execute: vi.fn().mockResolvedValue([]) },
  })),
  DatabaseMigrationService: vi.fn(() => ({
    initializeWithDatabase: vi.fn().mockResolvedValue(undefined),
    discoverAndRegisterPluginSchemas: vi.fn(),
    runAllPluginMigrations: vi.fn().mockResolvedValue(undefined),
  })),
  plugin: {},
}));

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
  },
  mkdirSync: vi.fn(),
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
}));

// Skip socket.io initialization for API tests
vi.mock('../src/socketio/index', () => ({
  setupSocketIO: vi.fn(() => ({})),
  SocketIORouter: vi.fn(() => ({
    setupListeners: vi.fn(),
  })),
}));

describe('API Server Functionality', () => {
  let server: AgentServer;
  let app: express.Application;

  beforeEach(async () => {
    server = new AgentServer();
    await server.initialize();
    app = server.app;
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  describe('Express App Configuration', () => {
    it('should create and configure express app', () => {
      expect(app).toBeDefined();
      expect(typeof app.listen).toBe('function');
      expect(typeof app.use).toBe('function');
      expect(app._router).toBeDefined();
    });

    it('should have middleware configured', () => {
      // Test that basic middleware functions exist
      expect(typeof server.registerMiddleware).toBe('function');
    });
  });

  describe('Agent Management API Structure', () => {
    it('should have agent management capabilities', () => {
      expect(typeof server.registerAgent).toBe('function');
      expect(typeof server.unregisterAgent).toBe('function');
      expect(server['agents']).toBeDefined();
      expect(server['agents'] instanceof Map).toBe(true);
    });

    it('should initialize with empty agent registry', () => {
      expect(server['agents'].size).toBe(0);
    });
  });

  describe('Database Integration', () => {
    it('should have database configured', () => {
      expect(server.database).toBeDefined();
      expect(typeof server.database.init).toBe('function');
      expect(typeof server.database.getMessageServers).toBe('function');
    });
  });

  describe('Server Lifecycle', () => {
    it('should be initialized after setup', () => {
      expect(server.isInitialized).toBe(true);
    });

    it('should have proper server structure', () => {
      expect(server.app).toBeDefined();
      expect(server.database).toBeDefined();
    });
  });
});