/**
 * `RuntimeMigrator` drives the diff-based schema migration that runs at agent
 * boot: snapshot the plugin's current Drizzle schema, diff it against the
 * last recorded snapshot (or an introspected baseline if none was recorded),
 * generate SQL, and apply it inside a transaction — no `drizzle-kit
 * generate` step required. Per-plugin PostgreSQL advisory locks (skipped on
 * PGlite/dev databases) prevent concurrent migration races across processes.
 * Destructive changes (dropped tables/columns, unsafe type changes) are
 * blocked unless `ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true` or `options.force`
 * is set. State is persisted via `MigrationTracker` (hash + timestamp),
 * `JournalStorage` (Drizzle-compatible journal), and `SnapshotStorage`.
 */
import { logger } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { getRow } from "../types";
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
import type { DrizzleDB, RuntimeMigrationOptions, SchemaSnapshot, SchemaTable } from "./types";

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
   * Get expected schema name for a plugin
   * @elizaos/plugin-sql uses 'public' schema (core application)
   * All other plugins should use namespaced schemas
   */
  private getExpectedSchemaName(pluginName: string): string {
    if (pluginName === "@elizaos/plugin-sql") {
      return "public";
    }

    return deriveSchemaName(pluginName);
  }

  /**
   * Ensure all schemas used in the snapshot exist
   */
  private async ensureSchemasExist(snapshot: SchemaSnapshot): Promise<void> {
    const schemasToCreate = new Set<string>();

    for (const table of Object.values(snapshot.tables)) {
      const schemaName = table.schema || "public";
      if (schemaName !== "public") {
        schemasToCreate.add(schemaName);
      }
    }

    for (const schema of Object.keys(snapshot.schemas || {})) {
      if (schema !== "public") {
        schemasToCreate.add(schema);
      }
    }

    for (const schemaName of schemasToCreate) {
      logger.debug({ src: "plugin:sql", schemaName }, "Ensuring schema exists");
      await this.db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`));
    }
  }

  /**
   * Validate schema usage and provide warnings
   */
  private validateSchemaUsage(pluginName: string, snapshot: SchemaSnapshot): void {
    const expectedSchema = this.getExpectedSchemaName(pluginName);
    const isCorePLugin = pluginName === "@elizaos/plugin-sql";

    for (const table of Object.values(snapshot.tables)) {
      const actualSchema = table.schema || "public";

      if (!isCorePLugin && actualSchema === "public") {
        logger.warn(
          {
            src: "plugin:sql",
            pluginName,
            tableName: table.name,
            expectedSchema,
          },
          "Plugin table is using public schema - consider using pgSchema for better isolation"
        );
      }

      if (isCorePLugin && actualSchema !== "public") {
        logger.warn(
          {
            src: "plugin:sql",
            pluginName: "@elizaos/plugin-sql",
            tableName: table.name,
            actualSchema,
          },
          "Core plugin table should use public schema"
        );
      }
    }
  }

  /**
   * Generate a stable advisory lock ID from plugin name
   * PostgreSQL advisory locks use bigint, so we need to hash the plugin name
   * and convert to a stable bigint value
   * Uses browser-compatible hashing
   */
  private getAdvisoryLockId(pluginName: string): bigint {
    return stringToBigInt(pluginName);
  }

  /**
   * Validate that a value is a valid PostgreSQL bigint
   * PostgreSQL bigint range: -9223372036854775808 to 9223372036854775807
   */
  private validateBigInt(value: bigint): boolean {
    const MIN_BIGINT = -9223372036854775808n;
    const MAX_BIGINT = 9223372036854775807n;
    return value >= MIN_BIGINT && value <= MAX_BIGINT;
  }

  /**
   * Detect if a connection string represents a real PostgreSQL database
   * (not PGLite, in-memory, or other non-PostgreSQL databases)
   */
  private isRealPostgresDatabase(connectionUrl: string): boolean {
    if (!connectionUrl.trim()) return false;

    const url = connectionUrl.trim().toLowerCase();

    // Exclude non-PostgreSQL databases (check schemes first)
    const nonPgSchemes = ["mysql://", "mysqli://", "mariadb://", "mongodb://", "mongodb+srv://"];
    if (nonPgSchemes.some((s) => url.startsWith(s))) return false;

    // Always reject :memory: databases (even with postgres:// scheme, it's not valid)
    if (url.includes(":memory:")) return false;

    // PostgreSQL URL schemes - check BEFORE other exclude patterns
    // (a postgres:// URL may have "sqlite" in the database name, that's OK)
    const pgSchemes = [
      "postgres://",
      "postgresql://",
      "postgis://",
      "pgbouncer://",
      "pgpool://",
      "cockroach://",
      "cockroachdb://",
      "redshift://",
      "timescaledb://",
      "yugabyte://",
    ];
    if (pgSchemes.some((s) => url.startsWith(s))) return true;

    // Exclude PGLite, SQLite databases (only for non-postgres:// URLs)
    const excludePatterns = ["pglite", "sqlite"];
    const urlBase = url.split("?")[0];
    if (excludePatterns.some((p) => url.includes(p))) return false;
    if (/\.(db|sqlite|sqlite3)$/.test(urlBase)) return false;

    // Local PostgreSQL (localhost, 127.0.0.1, Docker service names)
    if (url.includes("localhost") || url.includes("127.0.0.1")) return true;

    // PostgreSQL connection params (libpq style)
    const connParams = [
      "host=",
      "dbname=",
      "sslmode=",
      "connect_timeout=",
      "application_name=",
      "user=",
      "password=",
      "port=",
      "options=",
      "sslcert=",
      "sslkey=",
      "sslrootcert=",
      "fallback_application_name=",
      "keepalives=",
      "target_session_attrs=",
    ];
    if (connParams.some((p) => url.includes(p))) return true;

    // user@host format with postgres keyword or port
    if (url.includes("@") && (url.includes("postgres") || /:\d{4,5}/.test(url))) return true;

    // Common PostgreSQL ports
    if (/:(5432|5433|5434|6432|8432|9999|25060|26257)\b/.test(url)) return true;

    // Cloud providers
    const cloudPatterns = [
      // AWS
      "amazonaws.com",
      ".rds.",
      // Azure
      "azure.com",
      "database.azure.com",
      // Google Cloud
      "googleusercontent",
      "cloudsql",
      // Supabase
      "supabase",
      // Neon
      "neon.tech",
      "neon.build",
      // Railway
      "railway.app",
      "railway.internal",
      // Render
      "render.com",
      "onrender.com",
      // Heroku
      "heroku",
      // TimescaleDB
      "timescale",
      ".tsdb.cloud",
      // CockroachDB
      "cockroachlabs",
      "cockroachdb.cloud",
      ".crdb.io",
      // DigitalOcean
      "digitalocean",
      "db.ondigitalocean",
      "do-user-",
      // Aiven
      "aiven",
      // Crunchy Data
      "crunchydata",
      // ElephantSQL
      "elephantsql",
      // YugabyteDB
      "yugabyte",
      // Scaleway
      "scaleway",
      ".rdb.fr-par.scw.cloud",
      // Vercel Postgres
      "vercel-storage",
      // PlanetScale
      "psdb.cloud",
      // Xata
      "xata.sh",
      // Fly.io
      "fly.dev",
      "fly.io",
    ];
    if (cloudPatterns.some((p) => url.includes(p))) return true;

    // IP:port patterns (IPv4 and IPv6)
    if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}/.test(url)) return true;
    if (/\[[0-9a-f:]+\](:\d{1,5})?/i.test(connectionUrl)) return true;

    // host:port/database format (Docker Compose, etc.)
    if (/^[a-z0-9_.-]+:\d{1,5}\/[a-z0-9_-]+/i.test(connectionUrl)) return true;

    logger.debug(
      { src: "plugin:sql", urlPreview: url.substring(0, 50) },
      "Connection string did not match any PostgreSQL patterns"
    );
    return false;
  }

  /**
   * Initialize migration system - create necessary tables
   * @throws Error if table creation fails
   */
  async initialize(): Promise<void> {
    logger.info({ src: "plugin:sql" }, "Initializing migration system");
    await this.migrationTracker.ensureTables();
    logger.info({ src: "plugin:sql" }, "Migration system initialized");
  }

  /**
   * Run migrations for a plugin/schema
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema object
   * @param options - Migration options (verbose, force, dryRun, allowDataLoss)
   * @throws Error if destructive migrations blocked or migration fails
   */
  async migrate(
    pluginName: string,
    schema: Record<string, unknown>,
    options: RuntimeMigrationOptions = {}
  ): Promise<void> {
    const lockId = this.getAdvisoryLockId(pluginName);

    if (!this.validateBigInt(lockId)) {
      throw new Error(`Invalid advisory lock ID generated for plugin ${pluginName}`);
    }

    let lockAcquired = false;

    try {
      logger.info({ src: "plugin:sql", pluginName }, "Starting migration for plugin");

      await this.initialize();

      // Advisory locks only apply to real PostgreSQL — PGlite and other dev
      // databases don't need cross-process coordination.
      const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
      const isRealPostgres = this.isRealPostgresDatabase(postgresUrl);

      if (isRealPostgres) {
        try {
          logger.debug({ src: "plugin:sql", pluginName }, "Using PostgreSQL advisory locks");

          const lockIdStr = lockId.toString();

          const lockResult = await this.db.execute(
            sql`SELECT pg_try_advisory_lock(CAST(${lockIdStr} AS bigint)) as acquired`
          );

          interface LockResultRow {
            acquired: boolean;
          }
          lockAcquired = getRow<LockResultRow>(lockResult)?.acquired === true;

          if (!lockAcquired) {
            logger.info(
              { src: "plugin:sql", pluginName },
              "Migration already in progress, waiting for lock"
            );

            await this.db.execute(sql`SELECT pg_advisory_lock(CAST(${lockIdStr} AS bigint))`);
            lockAcquired = true;

            logger.info({ src: "plugin:sql", pluginName }, "Lock acquired");
          } else {
            logger.debug(
              { src: "plugin:sql", pluginName, lockId: lockIdStr },
              "Advisory lock acquired"
            );
          }
        } catch (lockError) {
          // Some PostgreSQL versions/configurations don't support advisory
          // locks — log and continue rather than blocking the migration.
          logger.warn(
            {
              src: "plugin:sql",
              pluginName,
              error: lockError instanceof Error ? lockError.message : String(lockError),
            },
            "Failed to acquire advisory lock, continuing without lock"
          );
          lockAcquired = false;
        }
      } else {
        logger.debug(
          { src: "plugin:sql" },
          "Development database detected, skipping advisory locks"
        );
      }

      // pgcrypto is only needed for real PostgreSQL — PGlite has native gen_random_uuid.
      const extensions = isRealPostgres
        ? ["vector", "fuzzystrmatch", "pgcrypto"]
        : ["vector", "fuzzystrmatch"];
      await this.extensionManager.installRequiredExtensions(extensions);

      const currentSnapshot = await generateSnapshot(schema);

      await this.ensureSchemasExist(currentSnapshot);

      this.validateSchemaUsage(pluginName, currentSnapshot);

      const currentHash = hashSnapshot(currentSnapshot);

      // Must re-check for an already-completed migration after acquiring the
      // lock: if this call had to wait for the lock, another process may have
      // already run this exact migration while we were waiting.
      const lastMigration = await this.migrationTracker.getLastMigration(pluginName);
      if (lastMigration && lastMigration.hash === currentHash) {
        logger.info(
          { src: "plugin:sql", pluginName, hash: currentHash },
          "No changes detected, skipping migration"
        );
        return;
      }

      let previousSnapshot = await this.snapshotStorage.getLatestSnapshot(pluginName);

      // No recorded snapshot but the plugin's tables already exist in the
      // database (e.g. pre-migrator install): introspect them to establish
      // a baseline instead of treating every existing table as newly created.
      if (!previousSnapshot && Object.keys(currentSnapshot.tables).length > 0) {
        const hasExistingTables = await this.introspector.hasExistingTables(pluginName);

        if (hasExistingTables) {
          logger.info(
            { src: "plugin:sql", pluginName },
            "No snapshot found but tables exist in database, introspecting"
          );

          const schemaName = this.getExpectedSchemaName(pluginName);

          const introspectedSnapshot = await this.introspector.introspectSchema(schemaName);

          // Filter to only tables defined in the current plugin's schema —
          // otherwise tables belonging to other plugins sharing the same
          // Postgres schema (e.g. other plugins in 'public') would be
          // classified as orphans and scheduled for deletion.
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
                { src: "plugin:sql", pluginName, tableName },
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
              { src: "plugin:sql", pluginName },
              "Created initial snapshot from existing database"
            );

            previousSnapshot = filteredSnapshot;
          }
        }
      }

      if (!hasChanges(previousSnapshot, currentSnapshot)) {
        logger.info({ src: "plugin:sql", pluginName }, "No schema changes");

        // Record even an empty schema so re-runs stay idempotent.
        if (!previousSnapshot && Object.keys(currentSnapshot.tables).length === 0) {
          logger.info({ src: "plugin:sql", pluginName }, "Recording empty schema");
          await this.migrationTracker.recordMigration(pluginName, currentHash, Date.now());
          const idx = await this.journalStorage.getNextIdx(pluginName);
          const tag = this.generateMigrationTag(idx, pluginName);
          await this.journalStorage.updateJournal(pluginName, idx, tag, true);
          await this.snapshotStorage.saveSnapshot(pluginName, idx, currentSnapshot);
        }

        return;
      }

      const diff = await calculateDiff(previousSnapshot, currentSnapshot);

      if (!hasDiffChanges(diff)) {
        logger.info({ src: "plugin:sql", pluginName }, "No actionable changes");
        return;
      }

      const dataLossCheck = checkForDataLoss(diff);

      if (dataLossCheck.hasDataLoss) {
        const isProduction = process.env.NODE_ENV === "production";

        // Explicit options take priority over the environment variable.
        const allowDestructive =
          options.force ||
          options.allowDataLoss ||
          process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true";

        if (!allowDestructive) {
          logger.error(
            {
              src: "plugin:sql",
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
            { src: "plugin:sql", pluginName, warnings: dataLossCheck.warnings },
            "Proceeding with destructive migration"
          );
        }
      }

      const sqlStatements = await generateMigrationSQL(previousSnapshot, currentSnapshot, diff);

      if (sqlStatements.length === 0) {
        logger.info({ src: "plugin:sql", pluginName }, "No SQL statements to execute");
        return;
      }

      logger.info(
        { src: "plugin:sql", pluginName, statementCount: sqlStatements.length },
        "Executing SQL statements"
      );
      if (options.verbose) {
        sqlStatements.forEach((stmt, i) => {
          logger.debug(
            { src: "plugin:sql", statementIndex: i + 1, statement: stmt },
            "SQL statement"
          );
        });
      }

      if (options.dryRun) {
        logger.info(
          { src: "plugin:sql", pluginName, statements: sqlStatements },
          "DRY RUN mode - not executing statements"
        );
        return;
      }

      await this.executeMigration(pluginName, currentSnapshot, currentHash, sqlStatements);

      logger.info({ src: "plugin:sql", pluginName }, "Migration completed successfully");

      return;
    } catch (error) {
      logger.error(
        {
          src: "plugin:sql",
          pluginName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Migration failed"
      );
      throw error;
    } finally {
      // Release the advisory lock if this call acquired one (real PostgreSQL only).
      const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
      const isRealPostgres = this.isRealPostgresDatabase(postgresUrl);

      if (lockAcquired && isRealPostgres) {
        try {
          const lockIdStr = lockId.toString();
          await this.db.execute(sql`SELECT pg_advisory_unlock(CAST(${lockIdStr} AS bigint))`);
          logger.debug({ src: "plugin:sql", pluginName }, "Advisory lock released");
        } catch (unlockError) {
          logger.warn(
            {
              src: "plugin:sql",
              pluginName,
              error: unlockError instanceof Error ? unlockError.message : String(unlockError),
            },
            "Failed to release advisory lock"
          );
        }
      }
    }
  }

  /**
   * Execute migration in a transaction
   */
  private async executeMigration(
    pluginName: string,
    snapshot: SchemaSnapshot,
    hash: string,
    sqlStatements: string[]
  ): Promise<void> {
    let transactionStarted = false;

    try {
      await this.db.execute(sql`BEGIN`);
      transactionStarted = true;

      for (const stmt of sqlStatements) {
        logger.debug({ src: "plugin:sql", statement: stmt }, "Executing SQL statement");
        await this.db.execute(sql.raw(stmt));
      }

      const idx = await this.journalStorage.getNextIdx(pluginName);

      await this.migrationTracker.recordMigration(pluginName, hash, Date.now());

      const tag = this.generateMigrationTag(idx, pluginName);
      await this.journalStorage.updateJournal(pluginName, idx, tag, /* breakpoints */ true);

      await this.snapshotStorage.saveSnapshot(pluginName, idx, snapshot);

      await this.db.execute(sql`COMMIT`);

      logger.info({ src: "plugin:sql", pluginName, tag }, "Recorded migration");
    } catch (error) {
      if (transactionStarted) {
        try {
          await this.db.execute(sql`ROLLBACK`);
          logger.error(
            {
              src: "plugin:sql",
              error: error instanceof Error ? error.message : String(error),
            },
            "Migration failed, rolled back"
          );
        } catch (rollbackError) {
          logger.error(
            {
              src: "plugin:sql",
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
   * Generate migration tag (like 0000_jazzy_shard)
   */
  private generateMigrationTag(idx: number, pluginName: string): string {
    // Simple index+timestamp tag; unlike drizzle-kit, this doesn't use word generation.
    const prefix = idx.toString().padStart(4, "0");
    const timestamp = Date.now().toString(36);
    return `${prefix}_${pluginName}_${timestamp}`;
  }

  /**
   * Get migration status for a plugin
   * @param pluginName - Plugin identifier
   * @returns Migration history and current state
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
   * Reset migrations for a plugin (dangerous - for development only)
   * @param pluginName - Plugin identifier
   * @warning Deletes all migration history - use only in development
   */
  async reset(pluginName: string): Promise<void> {
    logger.warn({ src: "plugin:sql", pluginName }, "Resetting migrations");

    await this.db.execute(
      sql`DELETE FROM migrations._migrations WHERE plugin_name = ${pluginName}`
    );
    await this.db.execute(sql`DELETE FROM migrations._journal WHERE plugin_name = ${pluginName}`);
    await this.db.execute(sql`DELETE FROM migrations._snapshots WHERE plugin_name = ${pluginName}`);

    logger.warn({ src: "plugin:sql", pluginName }, "Reset complete");
  }

  /**
   * Check if a migration would cause data loss without executing it
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema to check
   * @returns Data loss analysis or null if no changes
   */
  async checkMigration(
    pluginName: string,
    schema: Record<string, unknown>
  ): Promise<DataLossCheck | null> {
    try {
      logger.info({ src: "plugin:sql", pluginName }, "Checking migration");

      const currentSnapshot = await generateSnapshot(schema);

      const previousSnapshot = await this.snapshotStorage.getLatestSnapshot(pluginName);

      if (!hasChanges(previousSnapshot, currentSnapshot)) {
        logger.info({ src: "plugin:sql", pluginName }, "No changes detected");
        return null;
      }

      const diff = await calculateDiff(previousSnapshot, currentSnapshot);

      const dataLossCheck = checkForDataLoss(diff);

      if (dataLossCheck.hasDataLoss) {
        logger.warn({ src: "plugin:sql", pluginName }, "Migration would cause data loss");
      } else {
        logger.info({ src: "plugin:sql", pluginName }, "Migration is safe (no data loss)");
      }

      return dataLossCheck;
    } catch (error) {
      logger.error(
        {
          src: "plugin:sql",
          pluginName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to check migration"
      );
      throw error;
    }
  }
}
