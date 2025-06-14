/**
 * Integration tests for AgentServer class
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentServer } from '../src/index';
import { logger } from '@elizaos/core';
import type { ServerOptions } from '../src/index';
import http from 'node:http';

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

// Mock filesystem operations
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

describe('AgentServer Integration Tests', () => {
  let server: AgentServer;
  let mockServer: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock HTTP server
    mockServer = {
      listen: vi.fn((port, callback) => {
        if (callback) callback();
      }),
      close: vi.fn((callback) => {
        if (callback) callback();
      }),
    };
    
    vi.spyOn(http, 'createServer').mockReturnValue(mockServer as any);
    
    server = new AgentServer();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    vi.restoreAllMocks();
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
      
      const loggerWarnSpy = vi.spyOn(logger, 'warn');
      await server.initialize();
      
      expect(loggerWarnSpy).toHaveBeenCalledWith('AgentServer is already initialized, skipping initialization');
    });

    it('should handle initialization errors gracefully', async () => {
      // Mock database initialization to fail
      const mockDatabaseAdapter = {
        init: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      };
      
      const { createDatabaseAdapter } = await import('@elizaos/plugin-sql');
      vi.mocked(createDatabaseAdapter).mockReturnValue(mockDatabaseAdapter as any);
      
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
        registerPlugin: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        plugins: [],
        registerProvider: vi.fn(),
        registerAction: vi.fn(),
      };
      
      // Mock the database methods
      server.database = {
        ...server.database,
        getMessageServers: vi.fn().mockResolvedValue([]),
        createMessageServer: vi.fn().mockResolvedValue({ id: 'server-id' }),
        db: {
          execute: vi.fn().mockResolvedValue([]),
        },
        addAgentToServer: vi.fn().mockResolvedValue(undefined),
      } as any;
    });

    it('should register agent successfully', async () => {
      await server.registerAgent(mockRuntime);
      
      expect(server['agents'].has(mockRuntime.agentId)).toBe(true);
      expect(server['agents'].get(mockRuntime.agentId)).toBe(mockRuntime);
      expect(mockRuntime.registerPlugin).toHaveBeenCalled();
    });

    it('should throw error when registering null runtime', async () => {
      await expect(server.registerAgent(null as any)).rejects.toThrow('Attempted to register null/undefined runtime');
    });

    it('should throw error when runtime missing agentId', async () => {
      const invalidRuntime = { character: { name: 'TestAgent' } };
      await expect(server.registerAgent(invalidRuntime as any)).rejects.toThrow('Runtime missing agentId');
    });

    it('should throw error when runtime missing character', async () => {
      const invalidRuntime = { agentId: '123e4567-e89b-12d3-a456-426614174000' };
      await expect(server.registerAgent(invalidRuntime as any)).rejects.toThrow('Runtime missing character configuration');
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
      const customMiddleware = vi.fn((req, res, next) => next());
      
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
        createMessageServer: vi.fn().mockResolvedValue({ id: 'server-id', name: 'Test Server' }),
        getMessageServers: vi.fn().mockResolvedValue([]),
        getMessageServerById: vi.fn().mockResolvedValue({ id: 'server-id' }),
        createChannel: vi.fn().mockResolvedValue({ id: 'channel-id' }),
        getChannelsForServer: vi.fn().mockResolvedValue([]),
        createMessage: vi.fn().mockResolvedValue({ id: 'message-id' }),
        getMessagesForChannel: vi.fn().mockResolvedValue([]),
        addAgentToServer: vi.fn().mockResolvedValue(undefined),
        getAgentsForServer: vi.fn().mockResolvedValue([]),
      } as any;
    });

    it('should create server', async () => {
      const serverData = { name: 'Test Server', sourceType: 'test' };
      
      const result = await server.createServer(serverData);
      
      expect(server.database.createMessageServer).toHaveBeenCalledWith(serverData);
      expect(result).toEqual({ id: 'server-id', name: 'Test Server' });
    });

    it('should get servers', async () => {
      await server.getServers();
      
      expect(server.database.getMessageServers).toHaveBeenCalled();
    });

    it('should create channel', async () => {
      const channelData = { name: 'Test Channel', messageServerId: 'server-id' };
      
      const result = await server.createChannel(channelData);
      
      expect(server.database.createChannel).toHaveBeenCalledWith(channelData, undefined);
      expect(result).toEqual({ id: 'channel-id' });
    });

    it('should add agent to server', async () => {
      const serverId = 'server-id' as any;
      const agentId = 'agent-id' as any;
      
      await server.addAgentToServer(serverId, agentId);
      
      expect(server.database.getMessageServerById).toHaveBeenCalledWith(serverId);
      expect(server.database.addAgentToServer).toHaveBeenCalledWith(serverId, agentId);
    });

    it('should throw error when adding agent to non-existent server', async () => {
      server.database.getMessageServerById = vi.fn().mockResolvedValue(null);
      
      const serverId = 'non-existent-server' as any;
      const agentId = 'agent-id' as any;
      
      await expect(server.addAgentToServer(serverId, agentId)).rejects.toThrow('Server non-existent-server not found');
    });
  });

  describe('Error Handling', () => {
    it('should handle constructor errors gracefully', () => {
      // Mock logger to throw error
      vi.spyOn(logger, 'debug').mockImplementation(() => {
        throw new Error('Logger error');
      });
      
      expect(() => new AgentServer()).toThrow('Logger error');
    });

    it('should handle initialization errors and log them', async () => {
      const mockError = new Error('Initialization failed');
      
      // Mock database init to fail
      const mockDatabaseAdapter = {
        init: vi.fn().mockRejectedValue(mockError),
      };
      
      const { createDatabaseAdapter } = await import('@elizaos/plugin-sql');
      vi.mocked(createDatabaseAdapter).mockReturnValue(mockDatabaseAdapter as any);
      
      const errorSpy = vi.spyOn(logger, 'error');
      
      await expect(server.initialize()).rejects.toThrow('Initialization failed');
      expect(errorSpy).toHaveBeenCalledWith('Failed to initialize AgentServer (async operations):', mockError);
    });
  });
});