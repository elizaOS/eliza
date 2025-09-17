import { logger, type Plugin } from '@elizaos/core';
import { RuntimeMigrator } from './runtime-migrator';
import type { DrizzleDatabase } from './types';

export class DatabaseMigrationService {
  private db: DrizzleDatabase | null = null;
  private registeredSchemas = new Map<string, any>();
  private migrator: RuntimeMigrator | null = null;

  constructor() {
    // No longer extending Service, so no need to call super
  }

  async initializeWithDatabase(db: DrizzleDatabase): Promise<void> {
    this.db = db;
    this.migrator = new RuntimeMigrator(db);
    await this.migrator.initialize();
    logger.info('DatabaseMigrationService initialized with database and runtime migrator');
  }

  discoverAndRegisterPluginSchemas(plugins: Plugin[]): void {
    for (const plugin of plugins) {
      if ((plugin as any).schema) {
        this.registeredSchemas.set(plugin.name, (plugin as any).schema);
        logger.info(`Registered schema for plugin: ${plugin.name}`);
      }
    }
    logger.info(
      `Discovered ${this.registeredSchemas.size} plugin schemas out of ${plugins.length} plugins`
    );
  }

  registerSchema(pluginName: string, schema: any): void {
    this.registeredSchemas.set(pluginName, schema);
    logger.info(`Registered schema for plugin: ${pluginName}`);
  }

  async runAllPluginMigrations(): Promise<void> {
    if (!this.db || !this.migrator) {
      throw new Error('Database or migrator not initialized in DatabaseMigrationService');
    }

    logger.info(`Running migrations for ${this.registeredSchemas.size} plugins...`);

    for (const [pluginName, schema] of this.registeredSchemas) {
      logger.info(`Starting migration for plugin: ${pluginName}`);

      try {
        await this.migrator.migrate(pluginName, schema, { verbose: true });
        logger.info(`Completed migration for plugin: ${pluginName}`);
      } catch (error) {
        logger.error(`Failed to migrate plugin ${pluginName}:`, JSON.stringify(error));
        throw error; // Re-throw to maintain existing behavior
      }
    }

    logger.info('All plugin migrations completed.');
  }

  /**
   * Get the runtime migrator instance for advanced operations
   */
  getMigrator(): RuntimeMigrator | null {
    return this.migrator;
  }
}
