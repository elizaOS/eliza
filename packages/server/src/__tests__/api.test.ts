/**
 * API endpoint basic tests
 */

import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import express from 'express';
import http from 'node:http';
import { AgentServer } from '../index';

// Mock only plugin-sql to avoid real database operations
mock.module('@elizaos/plugin-sql', () => ({
  createDatabaseAdapter: jest.fn(() => ({
    init: jest.fn(() => Promise.resolve(undefined)),
    close: jest.fn(() => Promise.resolve(undefined)),
    getDatabase: jest.fn(() => ({
      execute: jest.fn(() => Promise.resolve([])),
    })),
    getMessageServers: jest
      .fn()
      .mockReturnValue(
        Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }])
      ),
    createMessageServer: jest.fn(() =>
      Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' })
    ),
    getAgentsForServer: jest.fn(() => Promise.resolve([])),
    addAgentToServer: jest.fn(() => Promise.resolve(undefined)),
    db: { execute: jest.fn(() => Promise.resolve([])) },
  })),
  DatabaseMigrationService: jest.fn(() => ({
    initializeWithDatabase: jest.fn(() => Promise.resolve(undefined)),
    discoverAndRegisterPluginSchemas: jest.fn(),
    runAllPluginMigrations: jest.fn(() => Promise.resolve(undefined)),
  })),
  plugin: {},
}));

mock.module('node:fs', () => ({
  default: {
    mkdirSync: jest.fn(),
    existsSync: jest.fn(() => true),
    readFileSync: jest.fn(() => '{}'),
    writeFileSync: jest.fn(),
  },
  mkdirSync: jest.fn(),
  existsSync: jest.fn(() => true),
  readFileSync: jest.fn(() => '{}'),
  writeFileSync: jest.fn(),
}));

// Mock Socket.IO
mock.module('socket.io', () => ({
  Server: jest.fn(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    to: jest.fn(() => ({
      emit: jest.fn(),
    })),
    close: jest.fn((callback) => {
      if (callback) callback();
    }),
  })),
}));

// Skip socket.io initialization for API tests
mock.module('../src/socketio/index', () => ({
  setupSocketIO: jest.fn(() => ({
    on: jest.fn(),
    emit: jest.fn(),
    to: jest.fn(() => ({
      emit: jest.fn(),
    })),
    close: jest.fn((callback) => {
      if (callback) callback();
    }),
  })),
  SocketIORouter: jest.fn(() => ({
    setupListeners: jest.fn(),
  })),
}));

describe('API Server Functionality', () => {
  let server: AgentServer;
  let app: express.Application;
  let mockServer: any;

  beforeEach(async () => {
    mock.restore();

    process.env.SENTRY_DSN = '';

    // Mock HTTP server with all methods Socket.IO expects
    mockServer = {
      listen: jest.fn((_port, callback) => {
        if (callback) callback();
      }),
      close: jest.fn((callback) => {
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

    jest.spyOn(http, 'createServer').mockReturnValue(mockServer as any);

    server = new AgentServer();
    await server.start({ isTestMode: true });
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
      expect(server.elizaOS).toBeDefined();
      expect(typeof server.elizaOS?.getAgents).toBe('function');
    });

    it('should initialize with empty agent registry', () => {
      expect(server.elizaOS).toBeDefined();
      const agents = server.elizaOS?.getAgents();
      expect(Array.isArray(agents)).toBe(true);
      expect(agents?.length).toBe(0);
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
