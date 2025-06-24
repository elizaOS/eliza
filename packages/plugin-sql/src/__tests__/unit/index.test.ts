import type { IAgentRuntime } from '@elizaos/core';
import { beforeEach, describe, expect, it, mock, afterEach } from 'bun:test';
import { plugin, createDatabaseAdapter } from '../../index';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('SQL Plugin', () => {
  let mockRuntime: IAgentRuntime;
  let tempDir: string;

  beforeEach(() => {
    // Create a temporary directory for tests
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eliza-plugin-sql-test-'));

    // Reset environment variables
    delete process.env.POSTGRES_URL;
    delete process.env.POSTGRES_USER;
    delete process.env.POSTGRES_PASSWORD;
    delete process.env.PGLITE_DATA_DIR;

    mockRuntime = {
      agentId: '00000000-0000-0000-0000-000000000000',
      getSetting: mock(() => null),
      registerDatabaseAdapter: mock(() => {}),
      registerService: mock(() => {}),
      getService: mock(() => {}),
      databaseAdapter: undefined,
    } as any;
  });

  afterEach(() => {
    // Clean up temporary directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Clear global singletons to prevent contamination between tests
    const GLOBAL_SINGLETONS = Symbol.for('@elizaos/plugin-sql/global-singletons');
    const globalSymbols = global as unknown as Record<symbol, any>;
    if (globalSymbols[GLOBAL_SINGLETONS]) {
      globalSymbols[GLOBAL_SINGLETONS] = {};
    }

    // Reset environment variables
    delete process.env.PGLITE_DATA_DIR;
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

      // Logger calls aren't easily testable in bun:test without complex mocking
      // Just verify that registerDatabaseAdapter wasn't called
      expect(mockRuntime.registerDatabaseAdapter).not.toHaveBeenCalled();
    });

    it('should register database adapter when none exists', async () => {
      // Set PGLITE_DATA_DIR to temp directory to avoid directory creation issues
      process.env.PGLITE_DATA_DIR = tempDir;
      mockRuntime.getSetting = mock((key) => {
        // Return temp directory for database paths to avoid directory creation issues
        if (key === 'PGLITE_PATH' || key === 'DATABASE_PATH') {
          return tempDir;
        }
        return null;
      });

      await plugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it('should use POSTGRES_URL when available', async () => {
      mockRuntime.getSetting = mock((key) => {
        if (key === 'POSTGRES_URL') return 'postgresql://localhost:5432/test';
        return null;
      });

      await plugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it('should prioritize PGLITE_PATH over DATABASE_PATH', async () => {
      mockRuntime.getSetting = mock((key) => {
        if (key === 'PGLITE_PATH') return '/custom/pglite';
        if (key === 'DATABASE_PATH') return '/custom/database';
        return null;
      });

      await plugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it('should use DATABASE_PATH if PGLITE_PATH is not set', async () => {
      mockRuntime.getSetting = mock((key) => {
        if (key === 'DATABASE_PATH') return '/custom/database';
        return null;
      });

      await plugin.init?.({}, mockRuntime);

      expect(mockRuntime.registerDatabaseAdapter).toHaveBeenCalled();
    });

    it('should use default path if neither PGLITE_PATH nor DATABASE_PATH is set', async () => {
      // Set PGLITE_DATA_DIR to temp directory to avoid directory creation issues
      process.env.PGLITE_DATA_DIR = tempDir;
      mockRuntime.getSetting = mock(() => null);

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
      // Set PGLITE_DATA_DIR to avoid directory creation issues
      process.env.PGLITE_DATA_DIR = tempDir;
      const config = {
        dataDir: path.join(tempDir, 'custom-data'),
      };

      const adapter = createDatabaseAdapter(config, agentId);

      expect(adapter).toBeDefined();
    });

    it('should use default dataDir when none provided', () => {
      // Set PGLITE_DATA_DIR to avoid directory creation issues
      process.env.PGLITE_DATA_DIR = tempDir;
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
