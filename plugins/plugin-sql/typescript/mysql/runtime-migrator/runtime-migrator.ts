import { logger } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { stringToBigInt } from "./crypto-utils";
import { DatabaseIntrospector } from "./drizzle-adapters/database-introspector";
import { calculateDiff, hasDiffChanges } from "./drizzle-adapters/diff-calculator";
import { generateSnapshot, hasChanges, hashSnapshot } from "./drizzle-adapters/snapshot-generator";
import {
  checkForDataLoss,
  type DataLossCheck,
  generateMigrationSQL,
} from "./drizzle-adapters/sql-generator";
import { ExtensionManager } from "./extension-manager";
import { deriveSchemaName } from "./schema-transformer";
import { JournalStorage } from "./storage/journal-storage";
import { MigrationTracker } from "./storage/migration-tracker";
import { SnapshotStorage } from "./storage/snapshot-storage";
import type {
  DrizzleDB,
  RuntimeMigrationOptions,
  SchemaSnapshot,
  SchemaTable,
} from "./types";
import { getMysqlRow } from "./types";

export class RuntimeMigrator {
  private migrationTracker: MigrationTracker;
  private journalStorage: JournalStorage;
  private snapshotStorage: SnapshotStorage;
  private extensionManager: ExtensionManager;
  private introspector: DatabaseIntrospector;

  constructor(private db: DrizzleDB) {
    this.migrationTracker = new MigrationTracker(db);
    this.journalStorage = new JournalStorage(db);
    this.snapshotStorage = new SnapshotStorage(db);
    this.extensionManager = new ExtensionManager(db);
    this.introspector = new DatabaseIntrospector(db);
  }

  /**
   * Get expected schema name for a plugin.
   * @elizaos/plugin-mysql uses the default database (empty string).
   * Other plugins use a derived name (for potential table prefixing).
   */
  private getExpectedSchemaName(pluginName: string): string {
    if (pluginName === "@elizaos/plugin-mysql") {
      return "";
    }
    return deriveSchemaName(pluginName);
  }

  /**
   * MySQL does not have PostgreSQL-style schemas.
   * All tables live in the current database. This is a no-op.
   */
  private async ensureSchemasExist(_snapshot: SchemaSnapshot): Promise<void> {
    // MySQL uses database-level isolation, not schema-level.
    // All tables live in the current database selected by MYSQL_URL.
  }

  /**
   * Validate schema usage and provide warnings (MySQL-adapted).
   */
  private validateSchemaUsage(pluginName: string, _snapshot: SchemaSnapshot): void {
    const isCorePLugin = pluginName === "@elizaos/plugin-mysql";
    if (!isCorePLugin) {
      logger.debug(
        { src: "plugin:mysql", pluginName },
        "Non-core plugin tables will share the default database"
      );
    }
  }

  /**
   * Generate a stable lock name from plugin name.
   * MySQL GET_LOCK() uses a string name (max 64 chars).
   */
  private getLockName(pluginName: string): string {
    // Use a prefix + hash to stay within 64-char limit
    const hash = stringToBigInt(pluginName).toString(16).slice(0, 16);
    return `eliza_migration_${hash}`;
  }

  /**
   * Detect if the connection string represents a real MySQL database.
   */
  private isRealMySQLDatabase(connectionUrl: string): boolean {
    if (!connectionUrl?.trim()) return false;

    const url = connectionUrl.trim().toLowerCase();

    // MySQL URL schemes
    const mysqlSchemes = ["mysql://", "mysql2://", "mysqli://", "mariadb://"];
    if (mysqlSchemes.some((s) => url.startsWith(s))) return true;

    // Reject in-memory or non-MySQL
    if (url.includes(":memory:")) return false;

    // Common MySQL ports
    if (/:(3306|3307|3308|33060)\b/.test(url)) return true;

    // Cloud MySQL providers
    const cloudPatterns = [
      "amazonaws.com",
      ".rds.",
      "azure.com",
      "database.azure.com",
      "googleusercontent",
      "cloudsql",
      "planetscale",
      "tidbcloud",
      "digitalocean",
      "railway.app",
      "railway.internal",
      "aiven",
      "scaleway",
    ];
    if (cloudPatterns.some((p) => url.includes(p))) return true;

    // localhost or IP-based connections
    if (url.includes("localhost") || url.includes("127.0.0.1")) return true;
    if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}/.test(url)) return true;

    logger.debug(
      { src: "plugin:mysql", urlPreview: url.substring(0, 50) },
      "Connection string did not match any MySQL patterns"
    );
    return false;
  }

  /**
   * Initialize migration system - create necessary tables.
   */
  async initialize(): Promise<void> {
    logger.info({ src: "plugin:mysql" }, "Initializing migration system");
    await this.migrationTracker.ensureTables();
    logger.info({ src: "plugin:mysql" }, "Migration system initialized");
  }

  /**
   * Run migrations for a plugin.
   * Uses MySQL GET_LOCK() for concurrency control instead of PostgreSQL advisory locks.
   */
  async migrate(
    pluginName: string,
    schema: Record<string, unknown>,
    options: RuntimeMigrationOptions = {}
  ): Promise<void> {
    const lockName = this.getLockName(pluginName);
    let lockAcquired = false;

    try {
      logger.info({ src: "plugin:mysql", pluginName }, "Starting migration for plugin");

      // Ensure migration tables exist
      await this.initialize();

      // Use MySQL named locks for concurrency control
      const mysqlUrl = process.env.MYSQL_URL || "";
      const isRealMySQL = this.isRealMySQLDatabase(mysqlUrl);

      if (isRealMySQL) {
        try {
          logger.debug({ src: "plugin:mysql", pluginName }, "Using MySQL named locks");

          // GET_LOCK(name, timeout) - try to acquire with 0 timeout first
          const lockResult = await this.db.execute(
            sql`SELECT GET_LOCK(${lockName}, 0) as acquired`
          );

          interface LockResultRow {
            acquired: number;
          }
          const lockRow = getMysqlRow<LockResultRow>(lockResult);
          lockAcquired = lockRow?.acquired === 1;

          if (!lockAcquired) {
            logger.info(
              { src: "plugin:mysql", pluginName },
              "Migration already in progress, waiting for lock"
            );

            // Wait up to 30 seconds for the lock
            const waitResult = await this.db.execute(
              sql`SELECT GET_LOCK(${lockName}, 30) as acquired`
            );
            const waitRow = getMysqlRow<LockResultRow>(waitResult);
            lockAcquired = waitRow?.acquired === 1;

            if (!lockAcquired) {
              throw new Error(`Could not acquire migration lock for ${pluginName} after 30s`);
            }

            logger.info({ src: "plugin:mysql", pluginName }, "Lock acquired");
          } else {
            logger.debug(
              { src: "plugin:mysql", pluginName, lockName },
              "Named lock acquired"
            );
          }
        } catch (lockError) {
          if (lockError instanceof Error && lockError.message.includes("Could not acquire")) {
            throw lockError;
          }
          logger.warn(
            {
              src: "plugin:mysql",
              pluginName,
              error: lockError instanceof Error ? lockError.message : String(lockError),
            },
            "Failed to acquire named lock, continuing without lock"
          );
          lockAcquired = false;
        }
      } else {
        logger.debug(
          { src: "plugin:mysql" },
          "Non-standard database detected, skipping named locks"
        );
      }

      // MySQL does not have extensions like PostgreSQL.
      // Vector support is built into MySQL 9.x. Just log for visibility.
      await this.extensionManager.installRequiredExtensions([]);

      // Generate current snapshot from schema
      const currentSnapshot = await generateSnapshot(schema);

      // MySQL doesn't use PostgreSQL-style schemas; this is a no-op
      await this.ensureSchemasExist(currentSnapshot);

      // Validate and warn about schema usage
      this.validateSchemaUsage(pluginName, currentSnapshot);

      const currentHash = hashSnapshot(currentSnapshot);

      // Check if we've already run this exact migration (after acquiring lock)
      const lastMigration = await this.migrationTracker.getLastMigration(pluginName);
      if (lastMigration && lastMigration.hash === currentHash) {
        logger.info(
          { src: "plugin:mysql", pluginName, hash: currentHash },
          "No changes detected, skipping migration"
        );
        return;
      }

      // Load previous snapshot
      let previousSnapshot = await this.snapshotStorage.getLatestSnapshot(pluginName);

      // If no snapshot exists but tables exist in database, introspect them
      if (!previousSnapshot && Object.keys(currentSnapshot.tables).length > 0) {
        const hasExistingTables = await this.introspector.hasExistingTables(pluginName);

        if (hasExistingTables) {
          logger.info(
            { src: "plugin:mysql", pluginName },
            "No snapshot found but tables exist in database, introspecting"
          );

          // For MySQL, introspect the current database (no schema separation)
          const schemaName = this.getExpectedSchemaName(pluginName);
          const introspectedSnapshot = await this.introspector.introspectSchema(schemaName);

          // Filter introspected tables to only those defined in the current schema
          const expectedTableNames = new Set<string>();
          for (const tableKey of Object.keys(currentSnapshot.tables)) {
            const tableData = currentSnapshot.tables[tableKey];
            const tableName = tableData.name || tableKey.split(".").pop() || "";
            expectedTableNames.add(tableName);
          }

          const filteredTables: Record<string, SchemaTable> = {};
          for (const tableKey of Object.keys(introspectedSnapshot.tables)) {
            const tableData = introspectedSnapshot.tables[tableKey];
            const tableName = tableData.name || tableKey.split(".").pop() || "";
            if (expectedTableNames.has(tableName)) {
              filteredTables[tableKey] = tableData;
            } else {
              logger.debug(
                { src: "plugin:mysql", pluginName, tableName },
                "Ignoring table from introspection (not in current schema)"
              );
            }
          }

          const filteredSnapshot = {
            ...introspectedSnapshot,
            tables: filteredTables,
          };

          if (Object.keys(filteredSnapshot.tables).length > 0) {
            await this.snapshotStorage.saveSnapshot(pluginName, 0, filteredSnapshot);

            await this.journalStorage.updateJournal(
              pluginName,
              0,
              `introspected_${Date.now()}`,
              true
            );

            const filteredHash = hashSnapshot(filteredSnapshot);
            await this.migrationTracker.recordMigration(pluginName, filteredHash, Date.now());

            logger.info(
              { src: "plugin:mysql", pluginName },
              "Created initial snapshot from existing database"
            );

            previousSnapshot = filteredSnapshot;
          }
        }
      }

      // Check if there are actual changes
      if (!hasChanges(previousSnapshot, currentSnapshot)) {
        logger.info({ src: "plugin:mysql", pluginName }, "No schema changes");

        if (!previousSnapshot && Object.keys(currentSnapshot.tables).length === 0) {
          logger.info({ src: "plugin:mysql", pluginName }, "Recording empty schema");
          await this.migrationTracker.recordMigration(pluginName, currentHash, Date.now());
          const idx = await this.journalStorage.getNextIdx(pluginName);
          const tag = this.generateMigrationTag(idx, pluginName);
          await this.journalStorage.updateJournal(pluginName, idx, tag, true);
          await this.snapshotStorage.saveSnapshot(pluginName, idx, currentSnapshot);
        }

        return;
      }

      // Calculate diff
      const diff = await calculateDiff(previousSnapshot, currentSnapshot);

      if (!hasDiffChanges(diff)) {
        logger.info({ src: "plugin:mysql", pluginName }, "No actionable changes");
        return;
      }

      // Check for potential data loss
      const dataLossCheck = checkForDataLoss(diff);

      if (dataLossCheck.hasDataLoss) {
        const isProduction = process.env.NODE_ENV === "production";

        const allowDestructive =
          options.force ||
          options.allowDataLoss ||
          process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true";

        if (!allowDestructive) {
          logger.error(
            {
              src: "plugin:mysql",
              pluginName,
              environment: isProduction ? "PRODUCTION" : "DEVELOPMENT",
              warnings: dataLossCheck.warnings,
            },
            "Destructive migration blocked - set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true or use force option"
          );

          const errorMessage = isProduction
            ? `Destructive migration blocked in production for ${pluginName}. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true or use drizzle-kit.`
            : `Destructive migration blocked for ${pluginName}. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true to proceed.`;

          throw new Error(errorMessage);
        }

        if (dataLossCheck.requiresConfirmation) {
          logger.warn(
            { src: "plugin:mysql", pluginName, warnings: dataLossCheck.warnings },
            "Proceeding with destructive migration"
          );
        }
      }

      // Generate SQL statements
      const sqlStatements = await generateMigrationSQL(previousSnapshot, currentSnapshot, diff);

      if (sqlStatements.length === 0) {
        logger.info({ src: "plugin:mysql", pluginName }, "No SQL statements to execute");
        return;
      }

      logger.info(
        { src: "plugin:mysql", pluginName, statementCount: sqlStatements.length },
        "Executing SQL statements"
      );
      if (options.verbose) {
        sqlStatements.forEach((stmt, i) => {
          logger.debug(
            { src: "plugin:mysql", statementIndex: i + 1, statement: stmt },
            "SQL statement"
          );
        });
      }

      // Dry run mode
      if (options.dryRun) {
        logger.info(
          { src: "plugin:mysql", pluginName, statements: sqlStatements },
          "DRY RUN mode - not executing statements"
        );
        return;
      }

      // Execute migration in transaction
      await this.executeMigration(pluginName, currentSnapshot, currentHash, sqlStatements);

      logger.info({ src: "plugin:mysql", pluginName }, "Migration completed successfully");
    } catch (error) {
      logger.error(
        {
          src: "plugin:mysql",
          pluginName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Migration failed"
      );
      throw error;
    } finally {
      // Release MySQL named lock if acquired
      if (lockAcquired) {
        try {
          await this.db.execute(sql`SELECT RELEASE_LOCK(${lockName})`);
          logger.debug({ src: "plugin:mysql", pluginName }, "Named lock released");
        } catch (unlockError) {
          logger.warn(
            {
              src: "plugin:mysql",
              pluginName,
              error: unlockError instanceof Error ? unlockError.message : String(unlockError),
            },
            "Failed to release named lock"
          );
        }
      }
    }
  }

  /**
   * Execute migration in a transaction.
   */
  private async executeMigration(
    pluginName: string,
    snapshot: SchemaSnapshot,
    hash: string,
    sqlStatements: string[]
  ): Promise<void> {
    let transactionStarted = false;

    try {
      // Start manual transaction
      await this.db.execute(sql`START TRANSACTION`);
      transactionStarted = true;

      // Execute all SQL statements
      for (const stmt of sqlStatements) {
        logger.debug({ src: "plugin:mysql", statement: stmt }, "Executing SQL statement");
        await this.db.execute(sql.raw(stmt));
      }

      // Get next index for journal
      const idx = await this.journalStorage.getNextIdx(pluginName);

      // Record migration
      await this.migrationTracker.recordMigration(pluginName, hash, Date.now());

      // Update journal
      const tag = this.generateMigrationTag(idx, pluginName);
      await this.journalStorage.updateJournal(pluginName, idx, tag, true);

      // Store snapshot
      await this.snapshotStorage.saveSnapshot(pluginName, idx, snapshot);

      // Commit
      await this.db.execute(sql`COMMIT`);

      logger.info({ src: "plugin:mysql", pluginName, tag }, "Recorded migration");
    } catch (error) {
      if (transactionStarted) {
        try {
          await this.db.execute(sql`ROLLBACK`);
          logger.error(
            {
              src: "plugin:mysql",
              error: error instanceof Error ? error.message : String(error),
            },
            "Migration failed, rolled back"
          );
        } catch (rollbackError) {
          logger.error(
            {
              src: "plugin:mysql",
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            },
            "Failed to rollback transaction"
          );
        }
      }
      throw error;
    }
  }

  /**
   * Generate migration tag (like 0000_jazzy_shard).
   */
  private generateMigrationTag(idx: number, pluginName: string): string {
    const prefix = idx.toString().padStart(4, "0");
    const timestamp = Date.now().toString(36);
    return `${prefix}_${pluginName}_${timestamp}`;
  }

  /**
   * Get migration status for a plugin.
   */
  async getStatus(pluginName: string): Promise<{
    hasRun: boolean;
    lastMigration: { id: number; hash: string; created_at: string } | null;
    journal: { version: string; dialect: string; entries: unknown[] } | null;
    snapshots: number;
  }> {
    const lastMigration = await this.migrationTracker.getLastMigration(pluginName);
    const journal = await this.journalStorage.loadJournal(pluginName);
    const snapshots = await this.snapshotStorage.getAllSnapshots(pluginName);

    return {
      hasRun: !!lastMigration,
      lastMigration,
      journal,
      snapshots: snapshots.length,
    };
  }

  /**
   * Reset migrations for a plugin (dangerous - for development only).
   */
  async reset(pluginName: string): Promise<void> {
    logger.warn({ src: "plugin:mysql", pluginName }, "Resetting migrations");

    await this.db.execute(
      sql`DELETE FROM _eliza_migrations WHERE plugin_name = ${pluginName}`
    );
    await this.db.execute(
      sql`DELETE FROM _eliza_journal WHERE plugin_name = ${pluginName}`
    );
    await this.db.execute(
      sql`DELETE FROM _eliza_snapshots WHERE plugin_name = ${pluginName}`
    );

    logger.warn({ src: "plugin:mysql", pluginName }, "Reset complete");
  }

  /**
   * Check if a migration would cause data loss without executing it.
   */
  async checkMigration(
    pluginName: string,
    schema: Record<string, unknown>
  ): Promise<DataLossCheck | null> {
    try {
      logger.info({ src: "plugin:mysql", pluginName }, "Checking migration");

      const currentSnapshot = await generateSnapshot(schema);
      const previousSnapshot = await this.snapshotStorage.getLatestSnapshot(pluginName);

      if (!hasChanges(previousSnapshot, currentSnapshot)) {
        logger.info({ src: "plugin:mysql", pluginName }, "No changes detected");
        return null;
      }

      const diff = await calculateDiff(previousSnapshot, currentSnapshot);
      const dataLossCheck = checkForDataLoss(diff);

      if (dataLossCheck.hasDataLoss) {
        logger.warn({ src: "plugin:mysql", pluginName }, "Migration would cause data loss");
      } else {
        logger.info({ src: "plugin:mysql", pluginName }, "Migration is safe (no data loss)");
      }

      return dataLossCheck;
    } catch (error) {
      logger.error(
        {
          src: "plugin:mysql",
          pluginName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to check migration"
      );
      throw error;
    }
  }
}
