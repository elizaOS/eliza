import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DatabaseMigrationService } from '../../migration-service';
import { logger, type Plugin } from '@elizaos/core';
import * as customMigrator from '../../custom-migrator';

// Mock the logger to avoid console output during tests
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
  };
});

// Mock the custom migrator
vi.mock('../../custom-migrator', () => ({
  runPluginMigrations: vi.fn().mockResolvedValue(undefined),
}));

describe('DatabaseMigrationService', () => {
  let migrationService: DatabaseMigrationService;
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock database
    mockDb = {
      query: {
        agentTable: { findFirst: vi.fn() },
        entityTable: { findFirst: vi.fn() },
        memoryTable: { findFirst: vi.fn() },
      },
      transaction: vi.fn(),
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };

    migrationService = new DatabaseMigrationService();
  });

  describe('constructor', () => {
    it('should create an instance', () => {
      expect(migrationService).toBeDefined();
      expect(migrationService).toBeInstanceOf(DatabaseMigrationService);
    });
  });

  describe('initializeWithDatabase', () => {
    it('should initialize with database', async () => {
      await migrationService.initializeWithDatabase(mockDb);

      expect(logger.info).toHaveBeenCalledWith(
        'DatabaseMigrationService initialized with database'
      );
      expect((migrationService as any).db).toBe(mockDb);
    });
  });

  describe('discoverAndRegisterPluginSchemas', () => {
    it('should register plugins with schemas', () => {
      const plugins: Plugin[] = [
        {
          name: 'plugin1',
          description: 'Test plugin 1',
          schema: { table1: {} },
        },
        {
          name: 'plugin2',
          description: 'Test plugin 2',
          schema: { table2: {} },
        },
        {
          name: 'plugin3',
          description: 'Plugin without schema',
        },
      ];

      migrationService.discoverAndRegisterPluginSchemas(plugins);

      expect(logger.info).toHaveBeenCalledWith('Registered schema for plugin: plugin1');
      expect(logger.info).toHaveBeenCalledWith('Registered schema for plugin: plugin2');
      expect(logger.info).toHaveBeenCalledWith('Discovered 2 plugin schemas out of 3 plugins');
    });

    it('should handle empty plugin array', () => {
      migrationService.discoverAndRegisterPluginSchemas([]);

      expect(logger.info).toHaveBeenCalledWith('Discovered 0 plugin schemas out of 0 plugins');
    });

    it('should handle plugins without schemas', () => {
      const plugins: Plugin[] = [
        {
          name: 'plugin1',
          description: 'Plugin without schema',
        },
        {
          name: 'plugin2',
          description: 'Another plugin without schema',
        },
      ];

      migrationService.discoverAndRegisterPluginSchemas(plugins);

      expect(logger.info).toHaveBeenCalledWith('Discovered 0 plugin schemas out of 2 plugins');
    });
  });

  describe('runAllPluginMigrations', () => {
    it('should throw if database not initialized', async () => {
      await expect(migrationService.runAllPluginMigrations()).rejects.toThrow(
        'Database not initialized in DatabaseMigrationService'
      );
    });

    it('should run migrations for registered plugins', async () => {
      // Initialize database
      await migrationService.initializeWithDatabase(mockDb);

      // Register plugins
      const plugins: Plugin[] = [
        {
          name: 'plugin1',
          description: 'Test plugin 1',
          schema: { table1: {} },
        },
        {
          name: 'plugin2',
          description: 'Test plugin 2',
          schema: { table2: {} },
        },
      ];

      migrationService.discoverAndRegisterPluginSchemas(plugins);

      // Run migrations
      await migrationService.runAllPluginMigrations();

      expect(logger.info).toHaveBeenCalledWith('Running migrations for 2 plugins...');
      expect(logger.info).toHaveBeenCalledWith('Starting migration for plugin: plugin1');
      expect(logger.info).toHaveBeenCalledWith('Starting migration for plugin: plugin2');
      expect(logger.info).toHaveBeenCalledWith('All plugin migrations completed.');

      expect(customMigrator.runPluginMigrations).toHaveBeenCalledTimes(2);
      expect(customMigrator.runPluginMigrations).toHaveBeenCalledWith(mockDb, 'plugin1', {
        table1: {},
      });
      expect(customMigrator.runPluginMigrations).toHaveBeenCalledWith(mockDb, 'plugin2', {
        table2: {},
      });
    });

    it('should handle migration errors', async () => {
      vi.mocked(customMigrator.runPluginMigrations).mockRejectedValueOnce(
        new Error('Migration failed')
      );

      // Initialize database
      await migrationService.initializeWithDatabase(mockDb);

      // Register a plugin
      migrationService.discoverAndRegisterPluginSchemas([
        {
          name: 'error-plugin',
          description: 'Test plugin',
          schema: { tables: {} },
        },
      ]);

      // Should propagate the error
      await expect(migrationService.runAllPluginMigrations()).rejects.toThrow('Migration failed');
    });

    it('should run migrations even with no plugins', async () => {
      // Initialize database
      await migrationService.initializeWithDatabase(mockDb);

      // Don't register any plugins

      // Run migrations
      await migrationService.runAllPluginMigrations();

      expect(logger.info).toHaveBeenCalledWith('Running migrations for 0 plugins...');
      expect(logger.info).toHaveBeenCalledWith('All plugin migrations completed.');
    });
  });
});
