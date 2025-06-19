/**
 * CLI Compatibility Tests
 *
 * Tests to ensure the server package maintains backward compatibility
 * with the CLI package usage patterns.
 */

import { describe, it, expect, mock, jest } from 'bun:test';

// Mock core dependencies
mock.module('@elizaos/core', () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
  },
  validateUuid: (id: string) => {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(id) ? id : null;
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
}));

// Mock plugin-sql
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
    db: { execute: jest.fn().mockReturnValue(Promise.resolve([])) },
  })),
  DatabaseMigrationService: jest.fn(() => ({
    initializeWithDatabase: jest.fn().mockReturnValue(Promise.resolve(undefined)),
    discoverAndRegisterPluginSchemas: jest.fn(),
    runAllPluginMigrations: jest.fn().mockReturnValue(Promise.resolve(undefined)),
  })),
  plugin: {},
}));

// Mock filesystem
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

describe('CLI Compatibility Tests', () => {
  describe('AgentServer API Compatibility', () => {
    it('should export AgentServer class with expected interface', async () => {
      const { AgentServer } = await import('../');

      expect(AgentServer).toBeDefined();
      expect(typeof AgentServer).toBe('function');

      const server = new AgentServer();

      // Check required methods that CLI uses
      expect(typeof server.initialize).toBe('function');
      expect(typeof server.start).toBe('function');
      expect(typeof server.stop).toBe('function');
      expect(typeof server.registerAgent).toBe('function');
      expect(typeof server.unregisterAgent).toBe('function');
      expect(typeof server.registerMiddleware).toBe('function');

      // Check properties that CLI assigns
      expect(server.hasOwnProperty('isInitialized')).toBe(true);
    });

    it('should allow CLI to extend server with custom methods', async () => {
      const { AgentServer } = await import('../');

      const server = new AgentServer();

      // Simulate CLI's pattern of extending the server
      const mockStartAgent = jest.fn();
      const mockStopAgent = jest.fn();
      const mockLoadCharacterTryPath = jest.fn();
      const mockJsonToCharacter = jest.fn();

      (server as any).startAgent = mockStartAgent;
      (server as any).stopAgent = mockStopAgent;
      (server as any).loadCharacterTryPath = mockLoadCharacterTryPath;
      (server as any).jsonToCharacter = mockJsonToCharacter;

      // Verify the extensions work
      expect((server as any).startAgent).toBe(mockStartAgent);
      expect((server as any).stopAgent).toBe(mockStopAgent);
      expect((server as any).loadCharacterTryPath).toBe(mockLoadCharacterTryPath);
      expect((server as any).jsonToCharacter).toBe(mockJsonToCharacter);
    });
  });

  describe('Loader Function Exports', () => {
    it('should export loadCharacterTryPath function', async () => {
      const { loadCharacterTryPath } = await import('../');

      expect(loadCharacterTryPath).toBeDefined();
      expect(typeof loadCharacterTryPath).toBe('function');
    });

    it('should export jsonToCharacter function', async () => {
      const { jsonToCharacter } = await import('../');

      expect(jsonToCharacter).toBeDefined();
      expect(typeof jsonToCharacter).toBe('function');
    });

    it('should export other loader utilities', async () => {
      const {
        tryLoadFile,
        loadCharactersFromUrl,
        loadCharacter,
        hasValidRemoteUrls,
        loadCharacters,
      } = await import('../');

      expect(tryLoadFile).toBeDefined();
      expect(loadCharactersFromUrl).toBeDefined();
      expect(loadCharacter).toBeDefined();
      expect(hasValidRemoteUrls).toBeDefined();
      expect(loadCharacters).toBeDefined();
    });
  });

  describe('Utility Function Exports', () => {
    it('should export expandTildePath function', async () => {
      const { expandTildePath } = await import('../');

      expect(expandTildePath).toBeDefined();
      expect(typeof expandTildePath).toBe('function');
    });

    it('should export resolvePgliteDir function', async () => {
      const { resolvePgliteDir } = await import('../');

      expect(resolvePgliteDir).toBeDefined();
      expect(typeof resolvePgliteDir).toBe('function');
    });
  });

  describe('Type Exports', () => {
    it('should export ServerOptions interface', async () => {
      const module = await import('../');

      // TypeScript interfaces don't exist at runtime, but we can check
      // that the module exports what we expect by testing usage patterns
      const server = new module.AgentServer();

      // Test that we can call initialize with ServerOptions-compatible object
      const options = {
        dataDir: './test-data',
        middlewares: [],
        postgresUrl: 'postgresql://test:test@localhost:5432/test',
      };

      // This should not throw a type error (tested at compile time)
      expect(() => server.initialize(options)).not.toThrow();
    });

    it('should export ServerMiddleware type compatibility', async () => {
      const module = await import('../');

      // Test that middleware function signature is compatible
      const testMiddleware = (_req: any, _res: any, next: any) => {
        next();
      };

      const server = new module.AgentServer();
      await server.initialize();

      // This should work with CLI's usage pattern
      expect(() => server.registerMiddleware(testMiddleware)).not.toThrow();
    });
  });

  describe('CLI Usage Patterns', () => {
    it('should support CLI initialization pattern', async () => {
      const { AgentServer } = await import('../');

      // Simulate CLI's server creation pattern
      const server = new AgentServer();

      const initOptions = {
        dataDir: './test-data',
        postgresUrl: undefined,
      };

      await server.initialize(initOptions);

      expect(server.isInitialized).toBe(true);
      expect(server.app).toBeDefined();
      expect(server.database).toBeDefined();
    });

    it('should support CLI server startup pattern', async () => {
      const { AgentServer } = await import('../');

      const server = new AgentServer();
      await server.initialize();

      // Mock HTTP server for testing
      const mockServer = {
        listen: jest.fn((_port, callback) => {
          if (callback) callback();
        }),
        close: jest.fn((callback) => {
          if (callback) callback();
        }),
      };

      server.server = mockServer as any;

      // Test CLI's server start pattern
      expect(() => server.start(3000)).not.toThrow();
      expect(mockServer.listen).toHaveBeenCalledWith(3000, expect.any(Function));
    });

    it('should support CLI agent registration pattern', async () => {
      const { AgentServer } = await import('../');

      const server = new AgentServer();
      await server.initialize();

      const mockRuntime = {
        agentId: '123e4567-e89b-12d3-a456-426614174000' as any,
        character: { name: 'TestAgent' },
        registerPlugin: jest.fn().mockReturnValue(Promise.resolve(undefined)),
        plugins: [],
        registerProvider: jest.fn(),
        registerAction: jest.fn(),
      } as any;

      // Mock database methods that registration uses
      server.database = {
        ...server.database,
        getMessageServers: jest.fn().mockReturnValue(Promise.resolve([])),
        addAgentToServer: jest.fn().mockReturnValue(Promise.resolve(undefined)),
        db: { execute: jest.fn().mockReturnValue(Promise.resolve([])) },
      } as any;

      // Test CLI's agent registration pattern
      await server.registerAgent(mockRuntime);

      expect(server['agents'].has(mockRuntime.agentId)).toBe(true);
    });
  });

  describe('Error Handling Compatibility', () => {
    it('should handle invalid agent registration gracefully', async () => {
      const { AgentServer } = await import('../');

      const server = new AgentServer();
      await server.initialize();

      // Test CLI error handling patterns
      await expect(server.registerAgent(null as any)).rejects.toThrow(
        'Attempted to register null/undefined runtime'
      );
      await expect(server.registerAgent({} as any)).rejects.toThrow('Runtime missing agentId');
    });

    it('should handle invalid server startup gracefully', async () => {
      const { AgentServer } = await import('../');

      const server = new AgentServer();
      await server.initialize();

      // Test CLI error handling for invalid ports
      expect(() => server.start(null as any)).toThrow('Invalid port number');
      expect(() => server.start('invalid' as any)).toThrow('Invalid port number');
    });
  });
});
