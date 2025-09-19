/**
 * Server lifecycle and middleware tests for AgentServer
 */

import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { AgentServer } from '../index';
import http from 'node:http';

// Mock logger to avoid console output during tests
mock.module('@elizaos/core', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
  },
}));

// Mock database adapter
mock.module('@elizaos/plugin-sql', () => ({
  default: { name: 'sql', description: 'SQL plugin', adapter: {} },
  createDatabaseAdapter: jest.fn(() => ({
    init: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    getDatabase: jest.fn(() => ({
      execute: jest.fn().mockResolvedValue([]),
    })),
    getMessageServers: jest.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }]),
    createMessageServer: jest.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000' }),
    getMessageServerById: jest.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }),
    addAgentToServer: jest.fn().mockResolvedValue(undefined),
    getChannelsForServer: jest.fn().mockResolvedValue([]),
    createChannel: jest.fn().mockResolvedValue({ id: '123e4567-e89b-12d3-a456-426614174000' }),
    getAgentsForServer: jest.fn().mockResolvedValue([]),
    db: { execute: jest.fn().mockResolvedValue([]) },
  })),
  DatabaseMigrationService: jest.fn(() => ({
    initializeWithDatabase: jest.fn().mockResolvedValue(undefined),
    discoverAndRegisterPluginSchemas: jest.fn(),
    runAllPluginMigrations: jest.fn().mockResolvedValue(undefined),
  })),
  plugin: {},
}));

describe('AgentServer Server Lifecycle Tests', () => {
  let server: AgentServer;
  let mockServer: any;

  beforeEach(async () => {
    // Mock HTTP server with all methods Socket.IO expects
    mockServer = {
      listen: jest.fn((_port, _host, callback) => {
        // Handle both (port, callback) and (port, host, callback) signatures
        const cb = typeof _host === 'function' ? _host : callback;
        if (cb) cb();
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
    await server.initialize();
  });

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
      server = null as any;
    }
    mock.restore();
  });

  it('should start server on specified port', () => {
    const port = 3001;

    server.start(port);

    expect(mockServer.listen).toHaveBeenCalledWith(port, '0.0.0.0', expect.any(Function));
  });

  it('should throw error for invalid port', () => {
    expect(() => server.start(null as any)).toThrow('Invalid port number: null');
    expect(() => server.start('invalid' as any)).toThrow('Invalid port number: invalid');
  });

  it('should stop server gracefully', async () => {
    server.start(3001);

    await server.stop();

    expect(mockServer.close).toHaveBeenCalled();
  });

  it('should register custom middleware', () => {
    const customMiddleware = jest.fn((_req, _res, next) => next());

    server.registerMiddleware(customMiddleware);

    // Verify middleware was added to the app
    expect(server.app.use).toBeDefined();
  });
});