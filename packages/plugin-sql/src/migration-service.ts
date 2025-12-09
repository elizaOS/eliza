import { logger, type Plugin, type IDatabaseAdapter } from '@elizaos/core';
import { RuntimeMigrator } from './runtime-migrator';
import type { DrizzleDatabase } from './types';
import { migrateToEntityRLS } from './migrations';
import { installRLSFunctions, applyRLSToNewTables, applyEntityRLSToAllTables } from './rls';

export class DatabaseMigrationService {
  private db: DrizzleDatabase | null = null;
  private registeredSchemas = new Map<string, Record<string, unknown>>();
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

    // TEMPORARY: Migrate from develop to feat/entity-rls (Owner RLS → Server RLS + Entity RLS)
    // This runs before the RuntimeMigrator to ensure schema compatibility
    // Can be removed after users have migrated from develop to this branch
    // migrateToEntityRLS expects IDatabaseAdapter, but we have db directly
    // Create a minimal adapter wrapper
    interface AdapterWrapper extends IDatabaseAdapter {
      db: DrizzleDatabase;
    }
    const adapterWrapper: AdapterWrapper = { db } as AdapterWrapper;
    await migrateToEntityRLS(adapterWrapper);

    this.migrator = new RuntimeMigrator(db);
    await this.migrator.initialize();
    logger.info({ src: 'plugin:sql' }, 'DatabaseMigrationService initialized');
  }

  /**
   * Auto-discover and register schemas from plugins
   * @param plugins - Array of plugins to scan for schemas
   */
  discoverAndRegisterPluginSchemas(plugins: Plugin[]): void {
    for (const plugin of plugins) {
      interface PluginWithSchema extends Plugin {
        schema?: Record<string, unknown>;
      }
      const pluginWithSchema = plugin as PluginWithSchema;
      if (pluginWithSchema.schema) {
        this.registeredSchemas.set(plugin.name, pluginWithSchema.schema);
      }
    }
    logger.info(
      {
        src: 'plugin:sql',
        schemasDiscovered: this.registeredSchemas.size,
        totalPlugins: plugins.length,
      },
      'Plugin schemas discovered'
    );
  }

  /**
   * Register a schema for a specific plugin
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema object
   */
  registerSchema(pluginName: string, schema: Record<string, unknown>): void {
    this.registeredSchemas.set(pluginName, schema);
    logger.debug({ src: 'plugin:sql', pluginName }, 'Schema registered');
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
    logger.info(
      {
        src: 'plugin:sql',
        environment: isProduction ? 'PRODUCTION' : 'DEVELOPMENT',
        pluginCount: this.registeredSchemas.size,
        dryRun: migrationOptions.dryRun,
      },
      'Starting migrations'
    );

    let successCount = 0;
    let failureCount = 0;
    const errors: Array<{ pluginName: string; error: Error }> = [];

    for (const [pluginName, schema] of this.registeredSchemas) {
      try {
        await this.migrator.migrate(pluginName, schema, migrationOptions);
        successCount++;
        logger.info({ src: 'plugin:sql', pluginName }, 'Migration completed');
      } catch (error) {
        failureCount++;
        const errorMessage = (error as Error).message;

        // Store the error for later
        errors.push({ pluginName, error: error as Error });

        if (errorMessage.includes('Destructive migration blocked')) {
          // Destructive migration was blocked - this is expected behavior
          logger.error(
            { src: 'plugin:sql', pluginName },
            'Migration blocked - destructive changes detected. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true or use force option'
          );
        } else {
          // Unexpected error
          logger.error({ src: 'plugin:sql', pluginName, error: errorMessage }, 'Migration failed');
        }
      }
    }

    // Final summary
    if (failureCount === 0) {
      logger.info({ src: 'plugin:sql', successCount }, 'All migrations completed successfully');

      // Re-apply RLS after all migrations are complete
      // This ensures RLS is active on all tables with proper server_id columns
      // ONLY if data isolation is enabled
      const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === 'true';

      if (dataIsolationEnabled) {
        try {
          logger.info({ src: 'plugin:sql' }, 'Re-applying Row Level Security...');
          // RLS functions expect IDatabaseAdapter, create wrapper
          interface AdapterWrapper extends IDatabaseAdapter {
            db: DrizzleDatabase;
          }
          const adapterWrapper: AdapterWrapper = { db: this.db } as AdapterWrapper;
          await installRLSFunctions(adapterWrapper);
          await applyRLSToNewTables(adapterWrapper);
          await applyEntityRLSToAllTables(adapterWrapper);
          logger.info({ src: 'plugin:sql' }, 'RLS re-applied successfully');
        } catch (rlsError) {
          const errorMsg = rlsError instanceof Error ? rlsError.message : String(rlsError);
          logger.warn(
            { src: 'plugin:sql', error: errorMsg },
            'Failed to re-apply RLS (this is OK if server_id columns are not yet in schemas)'
          );
        }
      } else {
        logger.info(
          { src: 'plugin:sql' },
          'Skipping RLS re-application (ENABLE_DATA_ISOLATION is not true)'
        );
      }
    } else {
      logger.error({ src: 'plugin:sql', failureCount, successCount }, 'Some migrations failed');

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
