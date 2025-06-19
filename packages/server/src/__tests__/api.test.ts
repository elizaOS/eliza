/**
 * API endpoint basic tests
 */

import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import express from 'express';
import http from 'node:http';
import { AgentServer } from '../index';

// Mock dependencies
mock.module('@elizaos/core', async () => {
  const actual = await import('@elizaos/core');
  return {
    ...actual,
    logger: {
      warn: mock.fn(),
      info: mock.fn(),
      error: mock.fn(),
      debug: mock.fn(),
      success: mock.fn(),
    },
    Service: class MockService {
      constructor() {}
      async initialize() {}
      async cleanup() {}
    },
    createUniqueUuid: mock.fn(() => '123e4567-e89b-12d3-a456-426614174000'),
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

mock.module('@elizaos/plugin-sql', () => ({
  createDatabaseAdapter: mock.fn(() => ({
    init: mock.fn(() => Promise.resolve(undefined)),
    close: mock.fn(() => Promise.resolve(undefined)),
    getDatabase: mock.fn(() => ({
      execute: mock.fn(() => Promise.resolve([])),
    })),
    getMessageServers: mock
      .fn()
      .mockReturnValue(Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }])),
    createMessageServer: mock.fn(() => Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' })),
    getAgentsForServer: mock.fn(() => Promise.resolve([])),
    addAgentToServer: mock.fn(() => Promise.resolve(undefined)),
    db: { execute: mock.fn(() => Promise.resolve([])) },
  })),
  DatabaseMigrationService: mock.fn(() => ({
    initializeWithDatabase: mock.fn(() => Promise.resolve(undefined)),
    discoverAndRegisterPluginSchemas: mock.fn(),
    runAllPluginMigrations: mock.fn(() => Promise.resolve(undefined)),
  })),
  plugin: {},
}));

mock.module('node:fs', () => ({
  default: {
    mkdirSync: mock.fn(),
    existsSync: mock.fn(() => true),
    readFileSync: mock.fn(() => '{}'),
    writeFileSync: mock.fn(),
  },
  mkdirSync: mock.fn(),
  existsSync: mock.fn(() => true),
  readFileSync: mock.fn(() => '{}'),
  writeFileSync: mock.fn(),
}));

// Mock Socket.IO
mock.module('socket.io', () => ({
  Server: mock.fn(() => ({
    on: mock.fn(),
    emit: mock.fn(),
    to: mock.fn(() => ({
      emit: mock.fn(),
    })),
    close: mock.fn((callback) => {
      if (callback) callback();
    }),
  })),
}));

// Skip socket.io initialization for API tests
mock.module('../src/socketio/index', () => ({
  setupSocketIO: mock.fn(() => ({
    on: mock.fn(),
    emit: mock.fn(),
    to: mock.fn(() => ({
      emit: mock.fn(),
    })),
    close: mock.fn((callback) => {
      if (callback) callback();
    }),
  })),
  SocketIORouter: mock.fn(() => ({
    setupListeners: mock.fn(),
  })),
}));

describe('API Server Functionality', () => {
  let server: AgentServer;
  let app: express.Application;
  let mockServer: any;

  beforeEach(async () => {
    mock.restore();

    // Mock HTTP server with all methods Socket.IO expects
    mockServer = {
      listen: mock.fn((port, callback) => {
        if (callback) callback();
      }),
      close: mock.fn((callback) => {
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

    mock.spyOn(http, 'createServer').mockReturnValue(mockServer as any);

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
      // _router might not exist immediately after initialization
      expect(app._router !== undefined || app.router !== undefined).toBe(true);
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
      expect(typeof (server.database as any).getMessageServers).toBe('function');
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
