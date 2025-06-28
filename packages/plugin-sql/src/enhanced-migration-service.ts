import { logger, type Plugin } from '@elizaos/core';
import { sql } from 'drizzle-orm';
import type { DrizzleDatabase } from './types';
import { DatabaseIntrospector } from './database-introspector';
import { SchemaDiffEngine } from './schema-diff-engine';
import { MigrationPlanner, type MigrationOptions } from './migration-planner';
import { MigrationExecutor } from './migration-executor';
import { MigrationHistoryManager } from './migration-history';
import { DrizzleSchemaIntrospector, PluginNamespaceManager } from './custom-migrator';
import type { TableDefinition } from './custom-migrator';

export interface EnhancedMigrationOptions extends MigrationOptions {
  enableAlterOperations?: boolean;
  createBackup?: boolean;
  showPlan?: boolean;
  recordHistory?: boolean;
}

export interface MigrationSummary {
  pluginName: string;
  success: boolean;
  duration: number;
  operationsExecuted: number;
  operationsFailed: number;
  migrationId?: string;
  warnings: string[];
  backupCreated: boolean;
}

/**
 * EnhancedMigrationService provides production-ready migration capabilities
 * with ALTER operations, safety checks, rollback support, and history tracking
 */
export class EnhancedMigrationService {
  private db: DrizzleDatabase | null = null;
  private registeredSchemas = new Map<string, any>();
  private dbIntrospector?: DatabaseIntrospector;
  private diffEngine?: SchemaDiffEngine;
  private planner?: MigrationPlanner;
  private executor?: MigrationExecutor;
  private historyManager?: MigrationHistoryManager;
  private schemaIntrospector?: DrizzleSchemaIntrospector;
  private namespaceManager?: PluginNamespaceManager;

  constructor() {
    // Initialize components when database is available
  }

  async initializeWithDatabase(db: DrizzleDatabase): Promise<void> {
    this.db = db;

    // Initialize all migration components
    this.dbIntrospector = new DatabaseIntrospector(db);
    this.diffEngine = new SchemaDiffEngine();
    this.planner = new MigrationPlanner();
    this.executor = new MigrationExecutor(db);
    this.historyManager = new MigrationHistoryManager(db);
    this.schemaIntrospector = new DrizzleSchemaIntrospector();
    this.namespaceManager = new PluginNamespaceManager(db);

    // Initialize migration history tracking
    await this.historyManager.initialize();

    logger.info('EnhancedMigrationService initialized with database and all components');
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

  /**
   * Runs enhanced migrations with ALTER support for all registered plugins
   */
  async runAllPluginMigrations(
    options: EnhancedMigrationOptions = {}
  ): Promise<MigrationSummary[]> {
    if (!this.db || !this.isInitialized()) {
      throw new Error('EnhancedMigrationService not properly initialized');
    }

    logger.info(`Running enhanced migrations for ${this.registeredSchemas.size} plugins...`);

    const summaries: MigrationSummary[] = [];
    const defaultOptions: EnhancedMigrationOptions = {
      enableAlterOperations: true,
      recordHistory: true,
      showPlan: true,
      dryRun: false,
      force: false,
      interactive: false,
      ...options,
    };

    for (const [pluginName, schema] of this.registeredSchemas) {
      logger.info(`Starting enhanced migration for plugin: ${pluginName}`);

      try {
        const summary = await this.runPluginMigration(pluginName, schema, defaultOptions);
        summaries.push(summary);

        if (summary.success) {
          logger.info(`✅ Migration successful for ${pluginName} (${summary.duration}ms)`);
        } else {
          logger.error(`❌ Migration failed for ${pluginName}`);
        }
      } catch (error) {
        logger.error(`Migration error for plugin ${pluginName}:`, error);
        summaries.push({
          pluginName,
          success: false,
          duration: 0,
          operationsExecuted: 0,
          operationsFailed: 1,
          warnings: [error instanceof Error ? error.message : 'Unknown error'],
          backupCreated: false,
        });
      }
    }

    const successCount = summaries.filter((s) => s.success).length;
    logger.info(`Enhanced migrations completed: ${successCount}/${summaries.length} successful`);

    return summaries;
  }

  /**
   * Runs enhanced migration for a single plugin
   */
  async runPluginMigration(
    pluginName: string,
    schema: any,
    options: EnhancedMigrationOptions = {}
  ): Promise<MigrationSummary> {
    const startTime = Date.now();
    const summary: MigrationSummary = {
      pluginName,
      success: false,
      duration: 0,
      operationsExecuted: 0,
      operationsFailed: 0,
      warnings: [],
      backupCreated: false,
    };

    try {
      // 1. Get schema name for the plugin
      const schemaName = await this.namespaceManager!.getPluginSchema(pluginName);
      await this.namespaceManager!.ensureNamespace(schemaName);

      // 2. Parse desired schema from plugin
      const desiredTables = this.parsePluginSchema(schema);
      logger.debug(`[ENHANCED MIGRATION] Parsed ${desiredTables.size} tables from plugin schema`);
      
      // Debug log the parsed tables
      for (const [tableName, tableDef] of desiredTables) {
        logger.info(`[ENHANCED MIGRATION] Table ${tableName}: ${tableDef.columns.length} columns`);
        for (const col of tableDef.columns) {
          logger.debug(`[ENHANCED MIGRATION]   Column: ${col.name} (${col.type})`);
        }
      }

      if (options.enableAlterOperations) {
        // 3. Introspect current database state
        const currentTables = await this.dbIntrospector!.introspectSchema(schemaName);
        logger.debug(
          `[ENHANCED MIGRATION] Found ${currentTables.size} existing tables in database`
        );

        // 4. Compute schema differences
        const diff = await this.diffEngine!.computeDiff(desiredTables, currentTables);

        // 5. Create migration plan
        const plan = await this.planner!.createPlan(diff, schemaName);
        summary.warnings.push(...plan.warnings.map((w) => w.message));

        if (options.showPlan) {
          this.logMigrationPlan(plan);
        }

        // 6. Execute migration plan
        if (plan.operations.length > 0) {
          const result = await this.executor!.executePlan(plan, options);

          summary.success = result.success;
          summary.operationsExecuted = result.executedOperations.length;
          summary.operationsFailed = result.failedOperations.length;

          // 7. Record migration history
          if (options.recordHistory) {
            try {
              summary.migrationId = await this.historyManager!.recordMigration(
                pluginName,
                result,
                plan.operations
              );
            } catch (error) {
              logger.warn('Failed to record migration history:', error);
            }
          }

          if (!result.success && result.error) {
            summary.warnings.push(result.error);

            // Check if this is an unsupported feature that should trigger fallback
            if (this.shouldFallbackOnError(result.error)) {
              logger.warn(
                `[ENHANCED MIGRATION] Detected unsupported feature for ${pluginName}, falling back immediately`
              );
              throw new Error(`Unsupported feature detected: ${result.error}`);
            }
          }
        } else {
          // No operations needed
          summary.success = true;
          logger.info(`[ENHANCED MIGRATION] No schema changes needed for ${pluginName}`);
        }
      } else {
        // Fallback to original migration approach
        logger.info(`[ENHANCED MIGRATION] Using fallback migration for ${pluginName}`);
        await this.runFallbackMigration(pluginName, schema);
        summary.success = true;
      }
    } catch (error) {
      logger.warn(
        `[ENHANCED MIGRATION] Enhanced migration failed for ${pluginName}, falling back to basic migration:`,
        error
      );

      try {
        // Clean up any partially created tables from failed enhanced migration
        await this.cleanupPartialMigration(pluginName);

        // Fallback to basic migration
        logger.info(`[ENHANCED MIGRATION] Using fallback migration for ${pluginName}`);
        await this.runFallbackMigration(pluginName, schema);
        summary.success = true;
        summary.warnings.push(
          `Enhanced migration failed, used fallback: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      } catch (fallbackError) {
        summary.success = false;
        summary.warnings.push(error instanceof Error ? error.message : 'Unknown error occurred');
        summary.warnings.push(
          `Fallback migration also failed: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown fallback error'}`
        );
        logger.error(
          `[ENHANCED MIGRATION] Both enhanced and fallback migrations failed for ${pluginName}:`,
          fallbackError
        );
      }
    }

    summary.duration = Date.now() - startTime;
    return summary;
  }

  /**
   * Performs a rollback of a specific migration
   */
  async rollbackMigration(
    migrationId: string,
    options: { force?: boolean } = {}
  ): Promise<boolean> {
    if (!this.historyManager) {
      throw new Error('Migration history not initialized');
    }

    logger.info(`[ENHANCED MIGRATION] Attempting rollback of migration ${migrationId}`);

    const success = await this.historyManager.rollbackMigration(migrationId, options);

    if (success) {
      logger.info(`[ENHANCED MIGRATION] Successfully rolled back migration ${migrationId}`);
    } else {
      logger.error(`[ENHANCED MIGRATION] Failed to rollback migration ${migrationId}`);
    }

    return success;
  }

  /**
   * Gets migration history for a plugin
   */
  async getPluginMigrationHistory(pluginName: string, limit: number = 10) {
    if (!this.historyManager) {
      throw new Error('Migration history not initialized');
    }

    return await this.historyManager.getPluginHistory(pluginName, limit);
  }

  /**
   * Gets migration statistics
   */
  async getMigrationStatistics() {
    if (!this.historyManager) {
      throw new Error('Migration history not initialized');
    }

    return await this.historyManager.getStatistics();
  }

  /**
   * Performs a dry run of migrations for all plugins
   */
  async dryRunMigrations(): Promise<MigrationSummary[]> {
    return await this.runAllPluginMigrations({
      dryRun: true,
      enableAlterOperations: true,
      recordHistory: false,
      showPlan: true,
    });
  }

  /**
   * Parses plugin schema into TableDefinition map
   */
  private parsePluginSchema(schema: any): Map<string, TableDefinition> {
    const tables = new Map<string, TableDefinition>();

    logger.info(`[ENHANCED MIGRATION] Parsing schema with keys: ${Object.keys(schema).join(', ')}`);

    // Discover all tables in the schema
    const tableEntries = Object.entries(schema).filter(([key, v]) => {
      const isDrizzleTable =
        v &&
        (((v as any)._ && typeof (v as any)._.name === 'string') ||
          (typeof v === 'object' &&
            v !== null &&
            ('tableName' in v || 'dbName' in v || key.toLowerCase().includes('table'))));
      
      logger.info(`[ENHANCED MIGRATION] Checking ${key}: isDrizzleTable=${isDrizzleTable}`);
      if (v && typeof v === 'object') {
        logger.debug(`[ENHANCED MIGRATION] Object properties: ${Object.keys(v).join(', ')}`);
        if ((v as any)._) {
          logger.debug(`[ENHANCED MIGRATION] Has _, name: ${(v as any)._.name}`);
        }
        if ((v as any).columns) {
          logger.debug(`[ENHANCED MIGRATION] Has columns: ${Object.keys((v as any).columns).join(', ')}`);
        }
      }
      
      return isDrizzleTable;
    });

    logger.debug(`[ENHANCED MIGRATION] Found ${tableEntries.length} table entries`);

    // Parse each table definition
    for (const [exportKey, table] of tableEntries) {
      logger.info(`[ENHANCED MIGRATION] Parsing table: ${exportKey}`);
      const tableDef = this.schemaIntrospector!.parseTableDefinition(table, exportKey);
      logger.info(`[ENHANCED MIGRATION] Parsed table ${tableDef.name} with ${tableDef.columns.length} columns`);
      tables.set(tableDef.name, tableDef);
    }

    return tables;
  }

  /**
   * Logs the migration plan for review
   */
  private logMigrationPlan(plan: any): void {
    if (plan.operations.length === 0) {
      logger.info('[MIGRATION PLAN] No operations needed');
      return;
    }

    logger.info(`[MIGRATION PLAN] ${plan.operations.length} operations planned:`);

    for (const [index, operation] of plan.operations.entries()) {
      const prefix = operation.isDestructive ? '⚠️ ' : '✅ ';
      logger.info(`  ${index + 1}. ${prefix}${operation.description}`);
    }

    if (plan.warnings.length > 0) {
      logger.warn('[MIGRATION PLAN] Warnings:');
      for (const warning of plan.warnings) {
        logger.warn(`  - ${warning.message}`);
      }
    }

    logger.info(`[MIGRATION PLAN] Estimated duration: ${plan.estimatedDuration}s`);
    if (plan.backupRecommended) {
      logger.warn('[MIGRATION PLAN] ⚠️  Backup recommended before execution');
    }
  }

  /**
   * Fallback to original migration approach
   */
  private async runFallbackMigration(pluginName: string, schema: any): Promise<void> {
    // Import and use the original migration function
    const { runPluginMigrations } = await import('./custom-migrator');
    await runPluginMigrations(this.db!, pluginName, schema);
  }

  /**
   * Checks if all components are initialized
   */
  private isInitialized(): boolean {
    return !!(
      this.dbIntrospector &&
      this.diffEngine &&
      this.planner &&
      this.executor &&
      this.historyManager &&
      this.schemaIntrospector &&
      this.namespaceManager
    );
  }

  /**
   * Cleans up old migration history
   */
  async cleanupHistory(keepDays: number = 90): Promise<number> {
    if (!this.historyManager) {
      throw new Error('Migration history not initialized');
    }

    return await this.historyManager.cleanupOldHistory(keepDays);
  }

  /**
   * Determines if an error should trigger fallback to basic migrations
   */
  private shouldFallbackOnError(errorMessage: string): boolean {
    const fallbackPatterns = [
      /type "vector" does not exist/i,
      /unknown data type: vector/i,
      /unrecognized data type name "vector"/i,
      /extension .* is not available/i,
      /function .* does not exist/i,
      /vector\(\d+\)/i, // Any vector type usage
      /DROP CONSTRAINT.*does not exist/i,
      /constraint.*does not exist/i,
      /ALTER TABLE.*DROP CONSTRAINT/i, // Any constraint dropping in PGLite
      /USER-DEFINED/i, // PGLite specific type issues
      /cannot drop.*primary key/i,
    ];

    return fallbackPatterns.some((pattern) => pattern.test(errorMessage));
  }

  /**
   * Cleans up any partially created tables from a failed migration
   */
  private async cleanupPartialMigration(pluginName: string): Promise<void> {
    if (!this.db || !this.namespaceManager) {
      return;
    }

    try {
      logger.debug(`[ENHANCED MIGRATION] Cleaning up partial migration for ${pluginName}`);

      const schemaName = await this.namespaceManager.getPluginSchema(pluginName);

      // Get list of tables that might have been partially created
      const tablesQuery = `
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = '${schemaName}' 
        AND table_name NOT LIKE '%__eliza_migrations%'
      `;

      const result = await this.db.execute(sql.raw(tablesQuery));
      const partialTables = (result.rows as any[]).map((row) => row.table_name);

      // Drop any tables that might be in an inconsistent state
      for (const tableName of partialTables) {
        try {
          await this.db.execute(
            sql.raw(`DROP TABLE IF EXISTS "${schemaName}"."${tableName}" CASCADE`)
          );
          logger.debug(`[ENHANCED MIGRATION] Cleaned up partial table: ${tableName}`);
        } catch (dropError) {
          logger.debug(`[ENHANCED MIGRATION] Could not drop table ${tableName}:`, dropError);
          // Continue with other cleanup
        }
      }
    } catch (error) {
      logger.debug(`[ENHANCED MIGRATION] Cleanup failed for ${pluginName}:`, error);
      // Don't throw - this is best effort cleanup
    }
  }
}
