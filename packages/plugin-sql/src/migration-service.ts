import { logger, type Plugin } from '@elizaos/core';
import { runPluginMigrations } from './custom-migrator';
import type { DrizzleDatabase } from './types';

export class DatabaseMigrationService {
  private db: DrizzleDatabase | null = null;
  private registeredSchemas = new Map<string, any>();

  constructor() {
    // No longer extending Service, so no need to call super
  }

  async initializeWithDatabase(db: DrizzleDatabase): Promise<void> {
    this.db = db;
    logger.info('DatabaseMigrationService initialized with database');
  }

  discoverAndRegisterPluginSchemas(plugins: Plugin[]): void {
    for (const plugin of plugins) {
      if (plugin.schema) {
        this.registeredSchemas.set(plugin.name, plugin.schema);
        logger.info(`Registered schema for plugin: ${plugin.name}`);
      }
    }
    logger.info(
      `Discovered ${this.registeredSchemas.size} plugin schemas out of ${plugins.length} plugins`
    );
  }

  async runAllPluginMigrations(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized in DatabaseMigrationService');
    }

    logger.info(`Running migrations for ${this.registeredSchemas.size} plugins...`);

    for (const [pluginName, schema] of this.registeredSchemas) {
      logger.info(`Starting migration for plugin: ${pluginName}`);
      // console.log(`[MIGRATION DEBUG] Processing plugin: ${pluginName}`);
      // console.log(`[MIGRATION DEBUG] Schema keys:`, Object.keys(schema));

      await runPluginMigrations(this.db!, pluginName, schema);

      // console.log(`[MIGRATION DEBUG] Completed migration for plugin: ${pluginName}`);
    }

    logger.info('All plugin migrations completed.');
  }
}
