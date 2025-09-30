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

  /**
   * Initialize service with database connection
   * @param db - Drizzle database instance
   */
  async initializeWithDatabase(db: DrizzleDatabase): Promise<void> {
    this.db = db;
    this.migrator = new RuntimeMigrator(db);
    await this.migrator.initialize();
    logger.info('DatabaseMigrationService initialized with database and runtime migrator');
  }

  /**
   * Auto-discover and register schemas from plugins
   * @param plugins - Array of plugins to scan for schemas
   */
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

  /**
   * Register a schema for a specific plugin
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema object
   */
  registerSchema(pluginName: string, schema: any): void {
    this.registeredSchemas.set(pluginName, schema);
    logger.info(`Registered schema for plugin: ${pluginName}`);
  }

  /**
   * Run migrations for all registered plugins
   * @param options - Migration options
   * @param options.verbose - Log detailed output (default: true in dev, false in prod)
   * @param options.force - Allow destructive migrations
   * @param options.dryRun - Preview changes without applying
   * @throws Error if any migration fails or destructive changes blocked
   */
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
    const errors: Array<{ pluginName: string; error: Error }> = [];

    for (const [pluginName, schema] of this.registeredSchemas) {
      try {
        await this.migrator.migrate(pluginName, schema, migrationOptions);
        successCount++;
        logger.info(`[DatabaseMigrationService] ✅ Completed: ${pluginName}`);
      } catch (error) {
        failureCount++;
        const errorMessage = (error as Error).message;

        // Store the error for later
        errors.push({ pluginName, error: error as Error });

        if (errorMessage.includes('Destructive migration blocked')) {
          // Destructive migration was blocked - this is expected behavior
          logger.error(
            `[DatabaseMigrationService] ❌ Blocked: ${pluginName} (destructive changes detected)`
          );

          // Check environment variable consistently with runtime-migrator.ts
          if (
            !migrationOptions.force &&
            process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS !== 'true'
          ) {
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

      // Throw a consolidated error with details about all failures
      const errorSummary = errors.map((e) => `${e.pluginName}: ${e.error.message}`).join('\n  ');
      throw new Error(`${failureCount} migration(s) failed:\n  ${errorSummary}`);
    }
  }

  /**
   * Get the runtime migrator instance for advanced operations
   * @returns RuntimeMigrator instance or null if not initialized
   */
  getMigrator(): RuntimeMigrator | null {
    return this.migrator;
  }
}
