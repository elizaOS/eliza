import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { AgentRuntime } from '../runtime';
import { IDatabaseAdapter, Plugin } from '../types';
import { mockCharacter } from './mockCharacter';

describe('AgentRuntime Plugin Migrations', () => {
  let mockDatabaseAdapter: IDatabaseAdapter;
  let runtime: AgentRuntime;
  let mockLogger: any;

  beforeEach(() => {
    // Mock database adapter
    mockDatabaseAdapter = {
      db: {},
      checkHealth: vi.fn().mockResolvedValue(true),
      init: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    } as any;

    // Mock logger
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
    };

    // Create runtime instance
    runtime = new AgentRuntime({
      character: mockCharacter,
      adapter: mockDatabaseAdapter,
      settings: {},
      plugins: [],
    });

    // Replace the runtime's logger with our mock
    (runtime as any).logger = mockLogger;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('runPluginMigrations', () => {
    it('should warn when drizzle instance not found', async () => {
      // Set adapter db to null to trigger the warning
      mockDatabaseAdapter.db = null;

      await runtime.runPluginMigrations();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Drizzle instance not found on adapter, skipping plugin migrations.'
      );
    });

    it('should skip migrations when no plugins have schemas', async () => {
      // Mock SQL plugin without schema
      const mockSqlPlugin: Plugin = {
        name: '@elizaos/plugin-sql',
        description: 'SQL plugin',
        actions: [],
        providers: [],
        services: [],
      };

      const runtimeAny = runtime as any;
      runtimeAny._plugins = [mockSqlPlugin];

      await runtime.runPluginMigrations();

      expect(mockLogger.info).toHaveBeenCalledWith('Found 0 plugins with schemas to migrate.');
    });

    it('should warn when SQL plugin not found', async () => {
      // Mock plugin with schema but no SQL plugin
      const mockTodoPlugin: Plugin = {
        name: 'todo',
        description: 'Todo plugin',
        actions: [],
        providers: [],
        services: [],
        schema: {
          todos: {},
          todo_tags: {},
        } as any,
      };

      const runtimeAny = runtime as any;
      runtimeAny._plugins = [mockTodoPlugin];

      // Also ensure the public plugins getter returns the same array
      Object.defineProperty(runtime, 'plugins', {
        get: function () {
          return runtimeAny._plugins;
        },
        configurable: true,
      });

      await runtime.runPluginMigrations();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SQL plugin not found or missing runPluginMigrations method')
      );
    });

    it('should run migrations for plugins with schemas', async () => {
      // Mock SQL plugin with migration function
      const mockRunPluginMigrations = vi.fn().mockResolvedValue(undefined);
      const mockSqlPlugin: Plugin & { runPluginMigrations?: Function } = {
        name: '@elizaos/plugin-sql',
        description: 'SQL plugin',
        actions: [],
        providers: [],
        services: [],
        runPluginMigrations: mockRunPluginMigrations,
      };

      // Mock plugin with schema
      const mockTodoPlugin: Plugin = {
        name: 'todo',
        description: 'Todo plugin',
        actions: [],
        providers: [],
        services: [],
        schema: {
          todos: {},
          todo_tags: {},
          user_points: {},
          point_history: {},
          daily_streaks: {},
        } as any,
      };

      const runtimeAny = runtime as any;
      // The runtime needs to have the SQL plugin in its plugins array
      runtimeAny._plugins = [mockSqlPlugin, mockTodoPlugin];

      // Also ensure the public plugins getter returns the same array
      Object.defineProperty(runtime, 'plugins', {
        get: function () {
          return runtimeAny._plugins;
        },
        configurable: true,
      });

      await runtime.runPluginMigrations();

      // Verify migration function was called with correct parameters
      // The SQL plugin's runPluginMigrations is called with (drizzle, pluginName, schema)
      expect(mockRunPluginMigrations).toHaveBeenCalledWith(
        mockDatabaseAdapter.db,
        'todo',
        mockTodoPlugin.schema
      );

      expect(mockLogger.info).toHaveBeenCalledWith('Running migrations for plugin: todo');
      expect(mockLogger.info).toHaveBeenCalledWith('Successfully migrated plugin: todo');
    });

    it('should count plugins with schemas correctly', async () => {
      const mockRunPluginMigrations = vi.fn().mockResolvedValue(undefined);

      const mockSqlPlugin: Plugin & { runPluginMigrations?: Function } = {
        name: '@elizaos/plugin-sql',
        description: 'SQL plugin',
        actions: [],
        providers: [],
        services: [],
        schema: { core_tables: {} } as any,
        runPluginMigrations: mockRunPluginMigrations,
      };

      const mockTodoPlugin: Plugin = {
        name: 'todo',
        description: 'Todo plugin',
        actions: [],
        providers: [],
        services: [],
        schema: { todos: {} } as any,
      };

      const mockTrustPlugin: Plugin = {
        name: 'trust',
        description: 'Trust plugin',
        actions: [],
        providers: [],
        services: [],
        schema: { trust_profiles: {} } as any,
      };

      const mockBootstrapPlugin: Plugin = {
        name: 'bootstrap',
        description: 'Bootstrap plugin',
        actions: [],
        providers: [],
        services: [],
        // No schema
      };

      const runtimeAny = runtime as any;
      runtimeAny._plugins = [mockSqlPlugin, mockTodoPlugin, mockTrustPlugin, mockBootstrapPlugin];

      // Also ensure the public plugins getter returns the same array
      Object.defineProperty(runtime, 'plugins', {
        get: function () {
          return runtimeAny._plugins;
        },
        configurable: true,
      });

      await runtime.runPluginMigrations();

      // Verify correct count (3 plugins with schemas, bootstrap doesn't have one)
      expect(mockLogger.info).toHaveBeenCalledWith('Found 3 plugins with schemas to migrate.');

      // Verify runPluginMigrations was called for each plugin with schema
      expect(mockRunPluginMigrations).toHaveBeenCalledTimes(3);
      expect(mockRunPluginMigrations).toHaveBeenCalledWith(
        mockDatabaseAdapter.db,
        '@elizaos/plugin-sql',
        mockSqlPlugin.schema
      );
      expect(mockRunPluginMigrations).toHaveBeenCalledWith(
        mockDatabaseAdapter.db,
        'todo',
        mockTodoPlugin.schema
      );
      expect(mockRunPluginMigrations).toHaveBeenCalledWith(
        mockDatabaseAdapter.db,
        'trust',
        mockTrustPlugin.schema
      );

      // Verify each plugin with schema was migrated
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Running migrations for plugin: @elizaos/plugin-sql'
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Running migrations for plugin: todo');
      expect(mockLogger.info).toHaveBeenCalledWith('Running migrations for plugin: trust');
    });

    it('should handle migration errors gracefully', async () => {
      const mockRunPluginMigrations = vi.fn().mockRejectedValue(new Error('Migration failed'));

      const mockSqlPlugin: Plugin & { runPluginMigrations?: Function } = {
        name: '@elizaos/plugin-sql',
        description: 'SQL plugin',
        actions: [],
        providers: [],
        services: [],
        schema: { test_tables: {} } as any,
        runPluginMigrations: mockRunPluginMigrations,
      };

      const runtimeAny = runtime as any;
      runtimeAny._plugins = [mockSqlPlugin];

      // Also ensure the public plugins getter returns the same array
      Object.defineProperty(runtime, 'plugins', {
        get: function () {
          return runtimeAny._plugins;
        },
        configurable: true,
      });

      // runPluginMigrations should throw when migration fails
      await expect(runtime.runPluginMigrations()).rejects.toThrow('Migration failed');

      // Should log error before throwing
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to migrate plugin @elizaos/plugin-sql:',
        expect.any(Error)
      );
    });

    it('should work with dynamic plugin loading', async () => {
      const mockRunPluginMigrations = vi.fn().mockResolvedValue(undefined);

      // Initially no plugins
      const runtimeAny = runtime as any;
      runtimeAny._plugins = [];

      // Dynamically add SQL plugin
      const mockSqlPlugin: Plugin & { runPluginMigrations?: Function } = {
        name: '@elizaos/plugin-sql',
        description: 'SQL plugin',
        actions: [],
        providers: [],
        services: [],
        runPluginMigrations: mockRunPluginMigrations,
      };

      runtimeAny._plugins.push(mockSqlPlugin);

      // Dynamically add todo plugin
      const mockTodoPlugin: Plugin = {
        name: 'todo',
        description: 'Todo plugin',
        actions: [],
        providers: [],
        services: [],
        schema: { todos: {} } as any,
      };

      runtimeAny._plugins.push(mockTodoPlugin);

      // Also ensure the public plugins getter returns the same array
      Object.defineProperty(runtime, 'plugins', {
        get: function () {
          return runtimeAny._plugins;
        },
        configurable: true,
      });

      await runtime.runPluginMigrations();

      // Verify runPluginMigrations was called for the todo plugin
      expect(mockRunPluginMigrations).toHaveBeenCalledWith(
        mockDatabaseAdapter.db,
        'todo',
        mockTodoPlugin.schema
      );
    });
  });

  describe('Plugin Schema Detection', () => {
    it('should correctly identify plugins with schemas', () => {
      const pluginWithSchema: Plugin = {
        name: 'with-schema',
        description: 'Plugin with schema',
        actions: [],
        providers: [],
        services: [],
        schema: { test_table: {} } as any,
      };

      const pluginWithoutSchema: Plugin = {
        name: 'without-schema',
        description: 'Plugin without schema',
        actions: [],
        providers: [],
        services: [],
      };

      const pluginWithEmptySchema: Plugin = {
        name: 'empty-schema',
        description: 'Plugin with empty schema',
        actions: [],
        providers: [],
        services: [],
        schema: {},
      };

      const runtimeAny = runtime as any;
      runtimeAny._plugins = [pluginWithSchema, pluginWithoutSchema, pluginWithEmptySchema];

      // Also ensure the public plugins getter returns the same array
      Object.defineProperty(runtime, 'plugins', {
        get: function () {
          return runtimeAny._plugins;
        },
        configurable: true,
      });

      const pluginsWithSchemas = runtime.plugins.filter(
        (p) => p.schema && Object.keys(p.schema).length > 0
      );

      expect(pluginsWithSchemas).toHaveLength(1);
      expect(pluginsWithSchemas[0].name).toBe('with-schema');
    });
  });
});
