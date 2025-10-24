/**
 * Initialization tests for AgentServer
 */

import { describe, it, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { AgentServer } from '../index';
import type { ServerConfig } from '../index';

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

describe('AgentServer Initialization Tests', () => {
  let server: AgentServer;

  beforeEach(() => {
    server = new AgentServer();
  });

  afterEach(async () => {
    if (server) {
      await server.stop().catch(() => {});
      server = null as any;
    }
  });

  it('should initialize server with default options', async () => {
    // Mock database adapter
    mock.module('@elizaos/plugin-sql', () => ({
      default: { name: 'sql', description: 'SQL plugin', adapter: {} },
      createDatabaseAdapter: jest.fn(() => ({
        init: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        getDatabase: jest.fn(() => ({
          execute: jest.fn().mockResolvedValue([]),
        })),
        getMessageServers: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
          ]),
        createMessageServer: jest
          .fn()
          .mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000' }),
        getMessageServerById: jest.fn().mockResolvedValue({
          id: '00000000-0000-0000-0000-000000000000',
          name: 'Default Server',
        }),
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

    await server.start({ isTestMode: true });

    expect(server.isInitialized).toBe(true);
    expect(server.database).toBeDefined();
    expect(server.elizaOS).toBeDefined();
  });

  it('should initialize server with custom options', async () => {
    const config: ServerConfig = {
      dataDir: './test-data',
      middlewares: [],
      postgresUrl: 'postgresql://test:test@localhost:5432/test',
      isTestMode: true,
    };

    // Mock database adapter
    mock.module('@elizaos/plugin-sql', () => ({
      default: { name: 'sql', description: 'SQL plugin', adapter: {} },
      createDatabaseAdapter: jest.fn(() => ({
        init: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        getDatabase: jest.fn(() => ({
          execute: jest.fn().mockResolvedValue([]),
        })),
        getMessageServers: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
          ]),
        createMessageServer: jest
          .fn()
          .mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000' }),
        getMessageServerById: jest.fn().mockResolvedValue({
          id: '00000000-0000-0000-0000-000000000000',
          name: 'Default Server',
        }),
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

    await server.start(config);

    expect(server.isInitialized).toBe(true);
  });

  it('should prevent double initialization', async () => {
    // Mock database adapter
    mock.module('@elizaos/plugin-sql', () => ({
      default: { name: 'sql', description: 'SQL plugin', adapter: {} },
      createDatabaseAdapter: jest.fn(() => ({
        init: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
        getDatabase: jest.fn(() => ({
          execute: jest.fn().mockResolvedValue([]),
        })),
        getMessageServers: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            { id: '00000000-0000-0000-0000-000000000000', name: 'Default Server' },
          ]),
        createMessageServer: jest
          .fn()
          .mockResolvedValue({ id: '00000000-0000-0000-0000-000000000000' }),
        getMessageServerById: jest.fn().mockResolvedValue({
          id: '00000000-0000-0000-0000-000000000000',
          name: 'Default Server',
        }),
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

    // First initialization
    await server.start({ isTestMode: true });
    expect(server.isInitialized).toBe(true);

    // Second initialization should be skipped (no error should be thrown)
    await server.start({ isTestMode: true });
    expect(server.isInitialized).toBe(true); // Should still be initialized
  });

  it('should handle initialization errors gracefully', async () => {
    // Mock database initialization to fail
    mock.module('@elizaos/plugin-sql', () => ({
      default: { name: 'sql', description: 'SQL plugin', adapter: {} },
      createDatabaseAdapter: jest.fn(() => ({
        init: jest.fn().mockRejectedValue(new Error('Database connection failed')),
      })),
      DatabaseMigrationService: jest.fn(() => ({
        initializeWithDatabase: jest.fn().mockResolvedValue(undefined),
        discoverAndRegisterPluginSchemas: jest.fn(),
        runAllPluginMigrations: jest.fn().mockResolvedValue(undefined),
      })),
      plugin: {},
    }));

    await expect(server.start({ isTestMode: true })).rejects.toThrow('Database connection failed');
  });
});
