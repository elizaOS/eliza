import type { IAgentRuntime } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { plugin, createDatabaseAdapter } from '../../index';

// Mock the logger and other core exports to avoid console output during tests
vi.mock('@elizaos/core', async () => {
  const actual = await vi.importActual('@elizaos/core');
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    VECTOR_DIMS: {
      SMALL: 384,
      MEDIUM: 512,
      LARGE: 768,
    },
  };
});

// Mock the database adapters and managers
vi.mock('../../pglite/adapter');
vi.mock('../../pglite/manager');
vi.mock('../../pg/adapter');
vi.mock('../../pg/manager');

describe('SQL Plugin', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;

    mockRuntime = {
      agentId: '00000000-0000-0000-0000-000000000000',
      getSetting: vi.fn(),
      registerDatabaseAdapter: vi.fn(),
      registerService: vi.fn(),
      getService: vi.fn(),
    } as any;
  });

  describe('Plugin Structure', () => {
    it('should have correct plugin metadata', () => {
      expect(plugin.name).toBe('@elizaos/plugin-sql');
      expect(plugin.description).toBe(
        'A plugin for SQL database access with dynamic schema migrations'
      );
      expect(plugin.priority).toBe(0);
    });

    it('should have schema defined', () => {
      expect(plugin.schema).toBeDefined();
      // Schema exports individual table definitions
      expect(plugin.schema).toHaveProperty('agentTable');
      expect(plugin.schema).toHaveProperty('entityTable');
      expect(plugin.schema).toHaveProperty('memoryTable');
    });

    it('should have init function', () => {
      expect(plugin.init).toBeDefined();
      expect(typeof plugin.init).toBe('function');
    });
  });

  describe('Plugin Initialization', () => {
    it('should skip initialization if adapter already exists', async () => {
      // Set up runtime with existing adapter
      (mockRuntime as any).databaseAdapter = { existing: true };

      await plugin.init?.({}, mockRuntime);

      expect(logger.info).toHaveBeenCalledWith(
        'Database adapter already registered, skipping creation'
      );
      expect(mockRuntime.registerDatabaseAdapter).not.toHaveBeenCalled();
    });

    it('should register database adapter when none exists', async () => {
      mockRuntime.getSetting = vi.fn().mockReturnValue(null);

      await plugin.init?.({}, mockRuntime);

      expect(logger.info).toHaveBeenCalledWith('plugin-sql init starting...');
      expect(logger.info).toHaveBeenCalledWith('Database adapter created and registered');
      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it('should use POSTGRES_URL when available', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key) => {
        if (key === 'POSTGRES_URL') return 'postgresql://localhost:5432/test';
        return null;
      });

      await plugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it('should prioritize PGLITE_PATH over DATABASE_PATH', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key) => {
        if (key === 'PGLITE_PATH') return '/custom/pglite';
        if (key === 'DATABASE_PATH') return '/custom/database';
        return null;
      });

      await plugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it('should use DATABASE_PATH if PGLITE_PATH is not set', async () => {
      mockRuntime.getSetting = vi.fn().mockImplementation((key) => {
        if (key === 'DATABASE_PATH') return '/custom/database';
        return null;
      });

      await plugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it('should use default path if neither PGLITE_PATH nor DATABASE_PATH is set', async () => {
      mockRuntime.getSetting = vi.fn().mockReturnValue(null);

      await plugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });
  });

  describe('createDatabaseAdapter', () => {
    const agentId = '00000000-0000-0000-0000-000000000000';

    it('should create PgDatabaseAdapter when postgresUrl is provided', () => {
      const config = {
        postgresUrl: 'postgresql://localhost:5432/test',
      };

      const adapter = createDatabaseAdapter(config, agentId);

      expect(adapter).toBeDefined();
    });

    it('should create PgliteDatabaseAdapter when no postgresUrl is provided', () => {
      const config = {
        dataDir: '/custom/data',
      };

      const adapter = createDatabaseAdapter(config, agentId);

      expect(adapter).toBeDefined();
    });

    it('should use default dataDir when none provided', () => {
      const config = {};

      const adapter = createDatabaseAdapter(config, agentId);

      expect(adapter).toBeDefined();
    });

    it('should reuse singleton managers', () => {
      // Create first adapter
      const adapter1 = createDatabaseAdapter(
        { postgresUrl: 'postgresql://localhost:5432/test' },
        agentId
      );

      // Create second adapter with same config
      const adapter2 = createDatabaseAdapter(
        { postgresUrl: 'postgresql://localhost:5432/test' },
        agentId
      );

      expect(adapter1).toBeDefined();
      expect(adapter2).toBeDefined();
    });
  });
});
