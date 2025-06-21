import {
  AgentRuntime,
  type IAgentRuntime,
  type Character,
  type Plugin,
  logger,
  type IDatabaseAdapter,
} from '@elizaos/core';
import { loadAndPreparePlugin } from '../../commands/start/utils/plugin-utils.js';
import { Client } from 'pg';

export interface TestAgentConfig {
  character: Character;
  plugins?: string[];
  modelProvider?: string;
  testDatabaseUrl?: string;
  apiKeys?: Record<string, string>;
}

export class TestAgentFactory {
  private agents: IAgentRuntime[] = [];
  private databaseAdapters: IDatabaseAdapter[] = [];

  async createRealAgent(config: TestAgentConfig): Promise<IAgentRuntime> {
    try {
      // Set up environment variables for API keys
      if (config.apiKeys) {
        Object.entries(config.apiKeys).forEach(([key, value]) => {
          process.env[key] = value;
        });
      }

      // Set up database URL
      const dbUrl =
        config.testDatabaseUrl ||
        process.env.TEST_DATABASE_URL ||
        'postgresql://test:test@localhost:5432/eliza_test';
      process.env.POSTGRES_URL = dbUrl;

      // Load real plugins
      const plugins: Plugin[] = [];

      // Dynamically import SQL plugin to avoid early schema loading
      const sqlModule = await import('@elizaos/plugin-sql');
      const sqlPlugin = sqlModule.plugin;
      plugins.push(sqlPlugin);

      if (config.plugins && config.plugins.length > 0) {
        for (const pluginName of config.plugins) {
          try {
            // Skip sql plugin since we already added it
            if (pluginName === 'sql') continue;

            // Try to load from @elizaos scope
            const plugin = await loadAndPreparePlugin(`@elizaos/plugin-${pluginName}`);
            if (plugin) {
              plugins.push(plugin);
              logger.info(`Loaded plugin: @elizaos/plugin-${pluginName}`);
            }
          } catch (error) {
            logger.warn(`Failed to load plugin ${pluginName}:`, error);
          }
        }
      }

      // Create character with plugins
      const character = {
        ...config.character,
        plugins: [...(config.plugins || []), 'sql'],
        settings: config.character.settings,
      };

      // Create real runtime
      const runtime = new AgentRuntime({
        character,
        plugins,
      });

      // Initialize the runtime - this will set up the database via the SQL plugin
      await runtime.initialize();
      this.agents.push(runtime);

      // Store the database adapter for cleanup
      if (runtime.adapter) {
        this.databaseAdapters.push(runtime.adapter);
      }

      logger.success(`Created real agent: ${config.character.name}`);
      return runtime;
    } catch (error) {
      logger.error('Failed to create real agent:', error);
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    // Clean up all agents
    for (const agent of this.agents) {
      try {
        await agent.stop();
      } catch (error) {
        logger.warn('Error stopping agent:', error);
      }
    }

    // Clean up all database adapters
    for (const adapter of this.databaseAdapters) {
      try {
        await adapter.close();
      } catch (error) {
        logger.warn('Error closing database adapter:', error);
      }
    }

    this.agents = [];
    this.databaseAdapters = [];
  }

  async createTestDatabase(dbName: string): Promise<string> {
    // Create a test-specific database using raw pg client
    const adminClient = new Client({
      connectionString:
        process.env.POSTGRES_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
    });

    try {
      await adminClient.connect();

      // Drop existing test database if it exists
      await adminClient.query(`DROP DATABASE IF EXISTS ${dbName}`);

      // Create new test database
      await adminClient.query(`CREATE DATABASE ${dbName}`);

      const testDbUrl = `postgresql://test:test@localhost:5432/${dbName}`;

      await adminClient.end();
      return testDbUrl;
    } catch (error) {
      await adminClient.end();
      throw error;
    }
  }

  async dropTestDatabase(dbName: string): Promise<void> {
    const adminClient = new Client({
      connectionString:
        process.env.POSTGRES_ADMIN_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
    });

    try {
      await adminClient.connect();
      await adminClient.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await adminClient.end();
    } catch (error) {
      await adminClient.end();
      throw error;
    }
  }
}
