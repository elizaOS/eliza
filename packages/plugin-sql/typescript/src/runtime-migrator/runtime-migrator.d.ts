import { type DataLossCheck } from "./drizzle-adapters/sql-generator";
import type { DrizzleDB, RuntimeMigrationOptions } from "./types";
export declare class RuntimeMigrator {
  private db;
  private migrationTracker;
  private journalStorage;
  private snapshotStorage;
  private extensionManager;
  private introspector;
  constructor(db: DrizzleDB);
  /**
   * Get expected schema name for a plugin
   * @elizaos/plugin-sql uses 'public' schema (core application)
   * All other plugins should use namespaced schemas
   */
  private getExpectedSchemaName;
  /**
   * Ensure all schemas used in the snapshot exist
   */
  private ensureSchemasExist;
  /**
   * Validate schema usage and provide warnings
   */
  private validateSchemaUsage;
  /**
   * Generate a stable advisory lock ID from plugin name
   * PostgreSQL advisory locks use bigint, so we need to hash the plugin name
   * and convert to a stable bigint value
   */
  private getAdvisoryLockId;
  /**
   * Validate that a value is a valid PostgreSQL bigint
   * PostgreSQL bigint range: -9223372036854775808 to 9223372036854775807
   */
  private validateBigInt;
  /**
   * Detect if a connection string represents a real PostgreSQL database
   * (not PGLite, in-memory, or other non-PostgreSQL databases)
   */
  private isRealPostgresDatabase;
  /**
   * Initialize migration system - create necessary tables
   * @throws Error if table creation fails
   */
  initialize(): Promise<void>;
  /**
   * Run migrations for a plugin/schema
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema object
   * @param options - Migration options (verbose, force, dryRun, allowDataLoss)
   * @throws Error if destructive migrations blocked or migration fails
   */
  migrate(
    pluginName: string,
    schema: any,
    options?: RuntimeMigrationOptions,
  ): Promise<void>;
  /**
   * Execute migration in a transaction
   */
  private executeMigration;
  /**
   * Generate migration tag (like 0000_jazzy_shard)
   */
  private generateMigrationTag;
  /**
   * Get migration status for a plugin
   * @param pluginName - Plugin identifier
   * @returns Migration history and current state
   */
  getStatus(pluginName: string): Promise<{
    hasRun: boolean;
    lastMigration: any;
    journal: any;
    snapshots: number;
  }>;
  /**
   * Reset migrations for a plugin (dangerous - for development only)
   * @param pluginName - Plugin identifier
   * @warning Deletes all migration history - use only in development
   */
  reset(pluginName: string): Promise<void>;
  /**
   * Check if a migration would cause data loss without executing it
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema to check
   * @returns Data loss analysis or null if no changes
   */
  checkMigration(
    pluginName: string,
    schema: any,
  ): Promise<DataLossCheck | null>;
}
//# sourceMappingURL=runtime-migrator.d.ts.map
