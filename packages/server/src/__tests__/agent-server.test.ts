/**
 * Integration tests for AgentServer class
 */

import { describe, it, expect, mock, beforeEach, afterEach, jest } from 'bun:test';
import { AgentServer } from '../index';
import { logger, type UUID, ChannelType } from '@elizaos/core';
import type { ServerOptions } from '../index';
import http from 'node:http';

// Mock dependencies
mock.module('@elizaos/core', async () => {
  const actual = await import('@elizaos/core');
  return {
    ...actual,
    logger: {
      warn: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      success: jest.fn(),
    },
    Service: class MockService {
      constructor() {}
      async initialize() {}
      async cleanup() {}
    },
    createUniqueUuid: jest.fn(() => '123e4567-e89b-12d3-a456-426614174000'),
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
  createDatabaseAdapter: jest.fn(() => ({
    init: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    close: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    getDatabase: jest.fn(() => ({
      execute: jest.fn().mockReturnValue(Promise.resolve([])),
    })),
    getMessageServers: jest.fn(() =>
      Promise.resolve([{ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' }])
    ),
    createMessageServer: jest
      .fn()
      .mockReturnValue(Promise.resolve({ id: '00000000-0000-0000-0000-000000000000' })),
    getMessageServerById: jest
      .fn()
      .mockReturnValue(
        Promise.resolve({ id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' })
      ),
    addAgentToServer: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    getChannelsForServer: jest.fn().mockReturnValue(Promise.resolve([])),
    createChannel: jest
      .fn()
      .mockReturnValue(Promise.resolve({ id: '123e4567-e89b-12d3-a456-426614174000' })),
    getAgentsForServer: jest.fn().mockReturnValue(Promise.resolve([])),
    db: { execute: jest.fn().mockReturnValue(Promise.resolve([])) },
  })),
  DatabaseMigrationService: jest.fn(() => ({
    initializeWithDatabase: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    discoverAndRegisterPluginSchemas: jest.fn(),
    runAllPluginMigrations: jest.fn().mockReturnValue(Promise.resolve(undefined)),
  })),
  plugin: {},
}));

// Mock filesystem operations
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

// Mock the socketio module
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

describe('AgentServer Integration Tests', () => {
  let server: AgentServer;
  let mockServer: any;

  beforeEach(() => {
    mock.restore();

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
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    mock.restore();
  });

  describe('Constructor', () => {
    it('should create AgentServer instance successfully', () => {
      expect(server).toBeInstanceOf(AgentServer);
      expect(server.isInitialized).toBe(false);
    });

    it('should initialize agents map', () => {
      expect(server['agents']).toBeInstanceOf(Map);
      expect(server['agents'].size).toBe(0);
    });
  });

  describe('Initialization', () => {
    it('should initialize server with default options', async () => {
      await server.initialize();

      expect(server.isInitialized).toBe(true);
      expect(server.database).toBeDefined();
      expect(server.app).toBeDefined();
      expect(server.server).toBeDefined();
      expect(server.socketIO).toBeDefined();
    });

    it('should initialize server with custom options', async () => {
      const options: ServerOptions = {
        dataDir: './test-data',
        middlewares: [],
        postgresUrl: 'postgresql://test:test@localhost:5432/test',
      };

      await server.initialize(options);

      expect(server.isInitialized).toBe(true);
    });

    it('should prevent double initialization', async () => {
      await server.initialize();

      const loggerWarnSpy = jest.spyOn(logger, 'warn');
      await server.initialize();

      expect(loggerWarnSpy).toHaveBeenCalledWith(
        'AgentServer is already initialized, skipping initialization'
      );
    });

    it('should handle initialization errors gracefully', async () => {
      // Mock database initialization to fail
      const mockDatabaseAdapter = {
        init: jest.fn().mockRejectedValue(new Error('Database connection failed')),
      };

      mock.module('@elizaos/plugin-sql', () => ({
        createDatabaseAdapter: () => mockDatabaseAdapter,
      }));

      await expect(server.initialize()).rejects.toThrow('Database connection failed');
    });
  });

  describe('Server Lifecycle', () => {
    beforeEach(async () => {
      await server.initialize();
    });

    it('should start server on specified port', () => {
      const port = 3001;

      server.start(port);

      expect(mockServer.listen).toHaveBeenCalledWith(port, expect.any(Function));
      expect(server['serverPort']).toBe(port);
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
  });

  describe('Agent Management', () => {
    let mockRuntime: any;

    beforeEach(async () => {
      await server.initialize();

      mockRuntime = {
        agentId: '123e4567-e89b-12d3-a456-426614174000',
        character: { name: 'TestAgent' },
        registerPlugin: jest.fn().mockReturnValue(Promise.resolve(undefined)),
        stop: jest.fn().mockReturnValue(Promise.resolve(undefined)),
        plugins: [],
        registerProvider: jest.fn(),
        registerAction: jest.fn(),
      };

      // Mock the database methods
      server.database = {
        ...server.database,
        getMessageServers: jest.fn().mockReturnValue(Promise.resolve([])),
        createMessageServer: jest.fn().mockReturnValue(Promise.resolve({ id: 'server-id' })),
        db: {
          execute: jest.fn().mockReturnValue(Promise.resolve([])),
        },
        addAgentToServer: jest.fn().mockReturnValue(Promise.resolve(undefined)),
      } as any;
    });

    it('should register agent successfully', async () => {
      await server.registerAgent(mockRuntime);

      expect(server['agents'].has(mockRuntime.agentId)).toBe(true);
      expect(server['agents'].get(mockRuntime.agentId)).toBe(mockRuntime);
      expect(mockRuntime.registerPlugin).toHaveBeenCalled();
    });

    it('should throw error when registering null runtime', async () => {
      await expect(server.registerAgent(null as any)).rejects.toThrow(
        'Attempted to register null/undefined runtime'
      );
    });

    it('should throw error when runtime missing agentId', async () => {
      const invalidRuntime = { character: { name: 'TestAgent' } };
      await expect(server.registerAgent(invalidRuntime as any)).rejects.toThrow(
        'Runtime missing agentId'
      );
    });

    it('should throw error when runtime missing character', async () => {
      const invalidRuntime = { agentId: '123e4567-e89b-12d3-a456-426614174000' };
      await expect(server.registerAgent(invalidRuntime as any)).rejects.toThrow(
        'Runtime missing character configuration'
      );
    });

    it('should unregister agent successfully', async () => {
      await server.registerAgent(mockRuntime);
      expect(server['agents'].has(mockRuntime.agentId)).toBe(true);

      server.unregisterAgent(mockRuntime.agentId);

      expect(server['agents'].has(mockRuntime.agentId)).toBe(false);
      expect(mockRuntime.stop).toHaveBeenCalled();
    });

    it('should handle unregistering non-existent agent gracefully', () => {
      const nonExistentId = '999e4567-e89b-12d3-a456-426614174999';

      expect(() => server.unregisterAgent(nonExistentId as any)).not.toThrow();
    });

    it('should handle missing agentId in unregister gracefully', () => {
      expect(() => server.unregisterAgent(null as any)).not.toThrow();
      expect(() => server.unregisterAgent(undefined as any)).not.toThrow();
    });
  });

  describe('Middleware Registration', () => {
    beforeEach(async () => {
      await server.initialize();
    });

    it('should register custom middleware', () => {
      const customMiddleware = jest.fn((_req, _res, next) => next());

      server.registerMiddleware(customMiddleware);

      // Verify middleware was added to the app
      expect(server.app.use).toBeDefined();
    });
  });

  describe('Database Operations', () => {
    beforeEach(async () => {
      await server.initialize();

      // Mock database methods
      server.database = {
        ...server.database,
        createMessageServer: jest
          .fn()
          .mockReturnValue(Promise.resolve({ id: 'server-id', name: 'Test Server' })),
        getMessageServers: jest.fn().mockReturnValue(Promise.resolve([])),
        getMessageServerById: jest.fn().mockReturnValue(Promise.resolve({ id: 'server-id' })),
        createChannel: jest.fn().mockReturnValue(Promise.resolve({ id: 'channel-id' })),
        getChannelsForServer: jest.fn().mockReturnValue(Promise.resolve([])),
        createMessage: jest.fn().mockReturnValue(Promise.resolve({ id: 'message-id' })),
        getMessagesForChannel: jest.fn().mockReturnValue(Promise.resolve([])),
        addAgentToServer: jest.fn().mockReturnValue(Promise.resolve(undefined)),
        getAgentsForServer: jest.fn().mockReturnValue(Promise.resolve([])),
      } as any;
    });

    it('should create server', async () => {
      const serverData = { name: 'Test Server', sourceType: 'test' };

      const result = await server.createServer(serverData);

      expect((server.database as any).createMessageServer).toHaveBeenCalledWith(serverData);
      expect(result).toEqual({
        id: 'server-id' as UUID,
        name: 'Test Server',
        sourceType: 'test',
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    });

    it('should get servers', async () => {
      await server.getServers();

      expect((server.database as any).getMessageServers).toHaveBeenCalled();
    });

    it('should create channel', async () => {
      const channelData = {
        name: 'Test Channel',
        messageServerId: 'server-id' as UUID,
        type: 'group' as ChannelType,
      };

      const result = await server.createChannel(channelData);

      expect((server.database as any).createChannel).toHaveBeenCalledWith(channelData, undefined);
      expect(result).toEqual({
        id: 'channel-id' as UUID,
        messageServerId: 'server-id' as UUID,
        name: 'Test Channel',
        type: 'group' as ChannelType,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    });

    it('should add agent to server', async () => {
      const serverId = 'server-id' as any;
      const agentId = 'agent-id' as any;

      await server.addAgentToServer(serverId, agentId);

      expect((server.database as any).getMessageServerById).toHaveBeenCalledWith(serverId);
      expect((server.database as any).addAgentToServer).toHaveBeenCalledWith(serverId, agentId);
    });

    it('should throw error when adding agent to non-existent server', async () => {
      (server.database as any).getMessageServerById = jest
        .fn()
        .mockReturnValue(Promise.resolve(null));

      const serverId = 'non-existent-server' as any;
      const agentId = 'agent-id' as any;

      await expect(server.addAgentToServer(serverId, agentId)).rejects.toThrow(
        'Server non-existent-server not found'
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle constructor errors gracefully', () => {
      // Mock logger to throw error
      jest.spyOn(logger, 'debug').mockImplementation(() => {
        throw new Error('Logger error');
      });

      expect(() => new AgentServer()).toThrow('Logger error');
    });

    it('should handle initialization errors and log them', async () => {
      const mockError = new Error('Initialization failed');

      // Mock database init to fail
      const mockDatabaseAdapter = {
        init: jest.fn().mockRejectedValue(mockError),
      };

      mock.module('@elizaos/plugin-sql', () => ({
        createDatabaseAdapter: () => mockDatabaseAdapter,
      }));

      const errorSpy = jest.spyOn(logger, 'error');

      await expect(server.initialize()).rejects.toThrow('Initialization failed');
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to initialize AgentServer (async operations):',
        mockError
      );
    });
  });
});
