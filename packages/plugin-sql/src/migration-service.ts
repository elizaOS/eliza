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

  async runAllPluginMigrations(options?: {
    verbose?: boolean;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<void> {
    if (!this.db || !this.migrator) {
      throw new Error('Database or migrator not initialized in DatabaseMigrationService');
    }

    const isProduction = process.env.NODE_ENV === 'production';

    // Build migration options with sensible defaults
    const migrationOptions = {
      verbose: options?.verbose ?? !isProduction,
      force: options?.force ?? false,
      dryRun: options?.dryRun ?? false,
    };

    // Log migration start
    logger.info('[DatabaseMigrationService] Starting migrations');
    logger.info(
      `[DatabaseMigrationService] Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`
    );
    logger.info(`[DatabaseMigrationService] Plugins to migrate: ${this.registeredSchemas.size}`);

    if (migrationOptions.dryRun) {
      logger.info('[DatabaseMigrationService] DRY RUN mode - no changes will be applied');
    }

    let successCount = 0;
    let failureCount = 0;

    for (const [pluginName, schema] of this.registeredSchemas) {
      try {
        await this.migrator.migrate(pluginName, schema, migrationOptions);
        successCount++;
        logger.info(`[DatabaseMigrationService] ✅ Completed: ${pluginName}`);
      } catch (error) {
        failureCount++;
        const errorMessage = (error as Error).message;

        if (errorMessage.includes('Destructive migration blocked')) {
          // Destructive migration was blocked - this is expected behavior
          logger.error(
            `[DatabaseMigrationService] ❌ Blocked: ${pluginName} (destructive changes detected)`
          );

          if (!migrationOptions.force && !process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS) {
            logger.error('[DatabaseMigrationService] To allow destructive migrations:');
            logger.error(
              '[DatabaseMigrationService]   - Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true'
            );
            logger.error('[DatabaseMigrationService]   - Or pass { force: true } to this method');
          }
        } else {
          // Unexpected error
          logger.error(
            `[DatabaseMigrationService] ❌ Failed: ${pluginName}`,
            JSON.stringify(error)
          );
        }

        // Re-throw to maintain existing behavior
        throw error;
      }
    }

    // Final summary
    if (failureCount === 0) {
      logger.info(
        `[DatabaseMigrationService] All ${successCount} migrations completed successfully`
      );
    } else {
      logger.error(
        `[DatabaseMigrationService] Migrations failed: ${failureCount} failed, ${successCount} succeeded`
      );
    }
  }

  /**
   * Get the runtime migrator instance for advanced operations
   */
  getMigrator(): RuntimeMigrator | null {
    return this.migrator;
  }
}
