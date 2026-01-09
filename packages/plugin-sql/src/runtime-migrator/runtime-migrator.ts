import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB, RuntimeMigrationOptions, SchemaSnapshot } from './types';
import { getRow } from '../types';
import { MigrationTracker } from './storage/migration-tracker';
import { JournalStorage } from './storage/journal-storage';
import { SnapshotStorage } from './storage/snapshot-storage';
import { ExtensionManager } from './extension-manager';
import { generateSnapshot, hashSnapshot, hasChanges } from './drizzle-adapters/snapshot-generator';
import { calculateDiff, hasDiffChanges } from './drizzle-adapters/diff-calculator';
import {
  generateMigrationSQL,
  checkForDataLoss,
  type DataLossCheck,
} from './drizzle-adapters/sql-generator';
import { deriveSchemaName } from './schema-transformer';
import { DatabaseIntrospector } from './drizzle-adapters/database-introspector';
import { createHash } from 'crypto';

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
    // Core plugin uses public schema
    if (pluginName === '@elizaos/plugin-sql') {
      return 'public';
    }

    // Use the schema transformer's logic for consistency
    return deriveSchemaName(pluginName);
  }

  /**
   * Ensure all schemas used in the snapshot exist
   */
  private async ensureSchemasExist(snapshot: SchemaSnapshot): Promise<void> {
    const schemasToCreate = new Set<string>();

    // Collect all schemas from tables
    for (const table of Object.values(snapshot.tables)) {
      const tableData = table as any; // Tables in snapshot have schema property
      const schema = tableData.schema || 'public';
      if (schema !== 'public') {
        schemasToCreate.add(schema);
      }
    }

    // Also add schemas from the snapshot's schemas object
    for (const schema of Object.keys(snapshot.schemas || {})) {
      if (schema !== 'public') {
        schemasToCreate.add(schema);
      }
    }

    // Create all non-public schemas
    for (const schemaName of schemasToCreate) {
      logger.debug({ src: 'plugin:sql', schemaName }, 'Ensuring schema exists');
      await this.db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`));
    }
  }

  /**
   * Validate schema usage and provide warnings
   */
  private validateSchemaUsage(pluginName: string, snapshot: SchemaSnapshot): void {
    const expectedSchema = this.getExpectedSchemaName(pluginName);
    const isCorePLugin = pluginName === '@elizaos/plugin-sql';

    for (const table of Object.values(snapshot.tables)) {
      const tableData = table as any; // Tables in snapshot have schema and name properties
      const actualSchema = tableData.schema || 'public';

      // Warn if non-core plugin is using public schema
      if (!isCorePLugin && actualSchema === 'public') {
        logger.warn(
          { src: 'plugin:sql', pluginName, tableName: tableData.name, expectedSchema },
          'Plugin table is using public schema - consider using pgSchema for better isolation'
        );
      }

      // Warn if core plugin is not using public schema
      if (isCorePLugin && actualSchema !== 'public') {
        logger.warn(
          {
            src: 'plugin:sql',
            pluginName: '@elizaos/plugin-sql',
            tableName: tableData.name,
            actualSchema,
          },
          'Core plugin table should use public schema'
        );
      }
    }
  }

  /**
   * Generate a stable advisory lock ID from plugin name
   * PostgreSQL advisory locks use bigint, so we need to hash the plugin name
   * and convert to a stable bigint value
   */
  private getAdvisoryLockId(pluginName: string): bigint {
    // Create a hash of the plugin name
    const hash = createHash('sha256').update(pluginName).digest();

    // Take first 8 bytes for a 64-bit integer
    const buffer = hash.slice(0, 8);

    // Convert to bigint
    let lockId = BigInt('0x' + buffer.toString('hex'));

    // Ensure the value fits in PostgreSQL's positive bigint range
    // Use a mask to keep only 63 bits (ensures positive in signed 64-bit)
    // This preserves uniqueness better than modulo and avoids collisions
    const mask63Bits = 0x7fffffffffffffffn; // 63 bits set to 1
    lockId = lockId & mask63Bits;

    // Ensure non-zero (extremely unlikely but handle it)
    if (lockId === 0n) {
      lockId = 1n;
    }

    return lockId;
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
    if (!connectionUrl?.trim()) return false;

    const url = connectionUrl.trim().toLowerCase();

    // Exclude non-PostgreSQL databases (check schemes first)
    const nonPgSchemes = ['mysql://', 'mysqli://', 'mariadb://', 'mongodb://', 'mongodb+srv://'];
    if (nonPgSchemes.some((s) => url.startsWith(s))) return false;

    // Always reject :memory: databases (even with postgres:// scheme, it's not valid)
    if (url.includes(':memory:')) return false;

    // PostgreSQL URL schemes - check BEFORE other exclude patterns
    // (a postgres:// URL may have "sqlite" in the database name, that's OK)
    const pgSchemes = [
      'postgres://',
      'postgresql://',
      'postgis://',
      'pgbouncer://',
      'pgpool://',
      'cockroach://',
      'cockroachdb://',
      'redshift://',
      'timescaledb://',
      'yugabyte://',
    ];
    if (pgSchemes.some((s) => url.startsWith(s))) return true;

    // Exclude PGLite, SQLite databases (only for non-postgres:// URLs)
    const excludePatterns = ['pglite', 'sqlite'];
    const urlBase = url.split('?')[0];
    if (excludePatterns.some((p) => url.includes(p))) return false;
    if (/\.(db|sqlite|sqlite3)$/.test(urlBase)) return false;

    // Local PostgreSQL (localhost, 127.0.0.1, Docker service names)
    if (url.includes('localhost') || url.includes('127.0.0.1')) return true;

    // PostgreSQL connection params (libpq style)
    const connParams = [
      'host=',
      'dbname=',
      'sslmode=',
      'connect_timeout=',
      'application_name=',
      'user=',
      'password=',
      'port=',
      'options=',
      'sslcert=',
      'sslkey=',
      'sslrootcert=',
      'fallback_application_name=',
      'keepalives=',
      'target_session_attrs=',
    ];
    if (connParams.some((p) => url.includes(p))) return true;

    // user@host format with postgres keyword or port
    if (url.includes('@') && (url.includes('postgres') || /:\d{4,5}/.test(url))) return true;

    // Common PostgreSQL ports
    if (/:(5432|5433|5434|6432|8432|9999|25060|26257)\b/.test(url)) return true;

    // Cloud providers
    const cloudPatterns = [
      // AWS
      'amazonaws.com',
      '.rds.',
      // Azure
      'azure.com',
      'database.azure.com',
      // Google Cloud
      'googleusercontent',
      'cloudsql',
      // Supabase
      'supabase',
      // Neon
      'neon.tech',
      'neon.build',
      // Railway
      'railway.app',
      'railway.internal',
      // Render
      'render.com',
      'onrender.com',
      // Heroku
      'heroku',
      // TimescaleDB
      'timescale',
      '.tsdb.cloud',
      // CockroachDB
      'cockroachlabs',
      'cockroachdb.cloud',
      '.crdb.io',
      // DigitalOcean
      'digitalocean',
      'db.ondigitalocean',
      'do-user-',
      // Aiven
      'aiven',
      // Crunchy Data
      'crunchydata',
      // ElephantSQL
      'elephantsql',
      // YugabyteDB
      'yugabyte',
      // Scaleway
      'scaleway',
      '.rdb.fr-par.scw.cloud',
      // Vercel Postgres
      'vercel-storage',
      // PlanetScale
      'psdb.cloud',
      // Xata
      'xata.sh',
      // Fly.io
      'fly.dev',
      'fly.io',
    ];
    if (cloudPatterns.some((p) => url.includes(p))) return true;

    // IP:port patterns (IPv4 and IPv6)
    if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}/.test(url)) return true;
    if (/\[[0-9a-f:]+\](:\d{1,5})?/i.test(connectionUrl)) return true;

    // host:port/database format (Docker Compose, etc.)
    if (/^[a-z0-9_.-]+:\d{1,5}\/[a-z0-9_-]+/i.test(connectionUrl)) return true;

    logger.debug(
      { src: 'plugin:sql', urlPreview: url.substring(0, 50) },
      'Connection string did not match any PostgreSQL patterns'
    );
    return false;
  }

  /**
   * Initialize migration system - create necessary tables
   * @throws Error if table creation fails
   */
  async initialize(): Promise<void> {
    logger.info({ src: 'plugin:sql' }, 'Initializing migration system');
    await this.migrationTracker.ensureTables();
    logger.info({ src: 'plugin:sql' }, 'Migration system initialized');
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
    schema: any,
    options: RuntimeMigrationOptions = {}
  ): Promise<void> {
    const lockId = this.getAdvisoryLockId(pluginName);

    // Validate lockId is within PostgreSQL bigint range
    if (!this.validateBigInt(lockId)) {
      throw new Error(`Invalid advisory lock ID generated for plugin ${pluginName}`);
    }

    let lockAcquired = false;

    try {
      logger.info({ src: 'plugin:sql', pluginName }, 'Starting migration for plugin');

      // Ensure migration tables exist
      await this.initialize();

      // Only use advisory locks for real PostgreSQL databases
      // Skip for PGLite or development databases
      const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
      const isRealPostgres = this.isRealPostgresDatabase(postgresUrl);

      if (isRealPostgres) {
        try {
          logger.debug({ src: 'plugin:sql', pluginName }, 'Using PostgreSQL advisory locks');

          // Convert bigint to string for SQL query
          // The sql tagged template will properly parameterize this value
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
              { src: 'plugin:sql', pluginName },
              'Migration already in progress, waiting for lock'
            );

            // Wait for the lock (blocking call)
            await this.db.execute(sql`SELECT pg_advisory_lock(CAST(${lockIdStr} AS bigint))`);
            lockAcquired = true;

            logger.info({ src: 'plugin:sql', pluginName }, 'Lock acquired');
          } else {
            logger.debug(
              { src: 'plugin:sql', pluginName, lockId: lockIdStr },
              'Advisory lock acquired'
            );
          }
        } catch (lockError) {
          // If advisory locks fail, log but continue
          // This might happen if the PostgreSQL version doesn't support advisory locks
          logger.warn(
            {
              src: 'plugin:sql',
              pluginName,
              error: lockError instanceof Error ? lockError.message : String(lockError),
            },
            'Failed to acquire advisory lock, continuing without lock'
          );
          lockAcquired = false;
        }
      } else {
        // For PGLite or other development databases, skip advisory locks
        logger.debug(
          { src: 'plugin:sql' },
          'Development database detected, skipping advisory locks'
        );
      }

      // Install required extensions
      // pgcrypto is only needed for real PostgreSQL (PGLite uses native gen_random_uuid)
      const extensions = isRealPostgres
        ? ['vector', 'fuzzystrmatch', 'pgcrypto']
        : ['vector', 'fuzzystrmatch'];
      await this.extensionManager.installRequiredExtensions(extensions);

      // Generate current snapshot from schema
      const currentSnapshot = await generateSnapshot(schema);

      // Ensure all schemas referenced in the snapshot exist
      await this.ensureSchemasExist(currentSnapshot);

      // Validate schema usage and warn about potential issues
      this.validateSchemaUsage(pluginName, currentSnapshot);

      const currentHash = hashSnapshot(currentSnapshot);

      // Check if we've already run this exact migration
      // This check happens AFTER acquiring the lock to handle concurrent scenarios
      // This is critical: if we had to wait for the lock (lockAcquired was initially false),
      // another process may have completed the migration while we were waiting
      // We MUST check regardless of whether lastMigration existed before
      const lastMigration = await this.migrationTracker.getLastMigration(pluginName);
      if (lastMigration && lastMigration.hash === currentHash) {
        logger.info(
          { src: 'plugin:sql', pluginName, hash: currentHash },
          'No changes detected, skipping migration'
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
            { src: 'plugin:sql', pluginName },
            'No snapshot found but tables exist in database, introspecting'
          );

          // Determine the schema name for introspection
          const schemaName = this.getExpectedSchemaName(pluginName);

          // Introspect the current database state
          const introspectedSnapshot = await this.introspector.introspectSchema(schemaName);

          // IMPORTANT: Filter the introspected snapshot to only include tables that are
          // defined in the current schema. This prevents tables from other plugins
          // (e.g., gamification tables in 'public' schema) from being marked as "orphans"
          // and scheduled for deletion.
          const expectedTableNames = new Set<string>();
          for (const tableKey of Object.keys(currentSnapshot.tables)) {
            const tableData = currentSnapshot.tables[tableKey] as any;
            const tableName = tableData.name || tableKey.split('.').pop();
            expectedTableNames.add(tableName);
          }

          // Filter introspected tables to only those in the current schema
          const filteredTables: any = {};
          for (const tableKey of Object.keys(introspectedSnapshot.tables)) {
            const tableData = introspectedSnapshot.tables[tableKey] as any;
            const tableName = tableData.name || tableKey.split('.').pop();
            if (expectedTableNames.has(tableName)) {
              filteredTables[tableKey] = tableData;
            } else {
              logger.debug(
                { src: 'plugin:sql', pluginName, tableName },
                'Ignoring table from introspection (not in current schema)'
              );
            }
          }

          // Use filtered snapshot
          const filteredSnapshot = {
            ...introspectedSnapshot,
            tables: filteredTables,
          };

          // Only use the introspected snapshot if it has tables
          if (Object.keys(filteredSnapshot.tables).length > 0) {
            // Save this as the initial snapshot (idx: 0)
            await this.snapshotStorage.saveSnapshot(pluginName, 0, filteredSnapshot);

            // Update journal to record this initial state
            await this.journalStorage.updateJournal(
              pluginName,
              0,
              `introspected_${Date.now()}`,
              true
            );

            // Record this as a migration
            const filteredHash = hashSnapshot(filteredSnapshot);
            await this.migrationTracker.recordMigration(pluginName, filteredHash, Date.now());

            logger.info(
              { src: 'plugin:sql', pluginName },
              'Created initial snapshot from existing database'
            );

            // Set this as the previous snapshot for comparison
            previousSnapshot = filteredSnapshot;
          }
        }
      }

      // Check if there are actual changes
      if (!hasChanges(previousSnapshot, currentSnapshot)) {
        logger.info({ src: 'plugin:sql', pluginName }, 'No schema changes');

        // For empty schemas, we still want to record the migration
        // to ensure idempotency and consistency
        if (!previousSnapshot && Object.keys(currentSnapshot.tables).length === 0) {
          logger.info({ src: 'plugin:sql', pluginName }, 'Recording empty schema');
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

      // Check if diff has changes
      if (!hasDiffChanges(diff)) {
        logger.info({ src: 'plugin:sql', pluginName }, 'No actionable changes');
        return;
      }

      // Check for potential data loss
      const dataLossCheck = checkForDataLoss(diff);

      if (dataLossCheck.hasDataLoss) {
        const isProduction = process.env.NODE_ENV === 'production';

        // Determine if destructive migrations are allowed
        // Priority: explicit options > environment variable
        const allowDestructive =
          options.force ||
          options.allowDataLoss ||
          process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === 'true';

        if (!allowDestructive) {
          // Block the migration and provide clear instructions
          logger.error(
            {
              src: 'plugin:sql',
              pluginName,
              environment: isProduction ? 'PRODUCTION' : 'DEVELOPMENT',
              warnings: dataLossCheck.warnings,
            },
            'Destructive migration blocked - set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true or use force option'
          );

          const errorMessage = isProduction
            ? `Destructive migration blocked in production for ${pluginName}. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true or use drizzle-kit.`
            : `Destructive migration blocked for ${pluginName}. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true to proceed.`;

          throw new Error(errorMessage);
        }

        // Log that we're proceeding with destructive operations
        if (dataLossCheck.requiresConfirmation) {
          logger.warn(
            { src: 'plugin:sql', pluginName, warnings: dataLossCheck.warnings },
            'Proceeding with destructive migration'
          );
        }
      }

      // Generate SQL statements
      const sqlStatements = await generateMigrationSQL(previousSnapshot, currentSnapshot, diff);

      if (sqlStatements.length === 0) {
        logger.info({ src: 'plugin:sql', pluginName }, 'No SQL statements to execute');
        return;
      }

      // Log what we're about to do
      logger.info(
        { src: 'plugin:sql', pluginName, statementCount: sqlStatements.length },
        'Executing SQL statements'
      );
      if (options.verbose) {
        sqlStatements.forEach((stmt, i) => {
          logger.debug(
            { src: 'plugin:sql', statementIndex: i + 1, statement: stmt },
            'SQL statement'
          );
        });
      }

      // Dry run mode - just log what would happen
      if (options.dryRun) {
        logger.info(
          { src: 'plugin:sql', pluginName, statements: sqlStatements },
          'DRY RUN mode - not executing statements'
        );
        return;
      }

      // Execute migration in transaction
      await this.executeMigration(pluginName, currentSnapshot, currentHash, sqlStatements);

      logger.info({ src: 'plugin:sql', pluginName }, 'Migration completed successfully');

      // Return a success result
      return;
    } catch (error) {
      logger.error(
        {
          src: 'plugin:sql',
          pluginName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Migration failed'
      );
      throw error;
    } finally {
      // Always release the advisory lock if we acquired it (only for real PostgreSQL)
      const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
      const isRealPostgres = this.isRealPostgresDatabase(postgresUrl);

      if (lockAcquired && isRealPostgres) {
        try {
          // Convert bigint to string for SQL query (same as when acquiring)
          const lockIdStr = lockId.toString();
          await this.db.execute(sql`SELECT pg_advisory_unlock(CAST(${lockIdStr} AS bigint))`);
          logger.debug({ src: 'plugin:sql', pluginName }, 'Advisory lock released');
        } catch (unlockError) {
          logger.warn(
            {
              src: 'plugin:sql',
              pluginName,
              error: unlockError instanceof Error ? unlockError.message : String(unlockError),
            },
            'Failed to release advisory lock'
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
      // Start manual transaction
      await this.db.execute(sql`BEGIN`);
      transactionStarted = true;

      // Execute all SQL statements
      for (const stmt of sqlStatements) {
        logger.debug({ src: 'plugin:sql', statement: stmt }, 'Executing SQL statement');
        await this.db.execute(sql.raw(stmt));
      }

      // Get next index for journal
      const idx = await this.journalStorage.getNextIdx(pluginName);

      // Record migration
      await this.migrationTracker.recordMigration(pluginName, hash, Date.now());

      // Update journal
      const tag = this.generateMigrationTag(idx, pluginName);
      await this.journalStorage.updateJournal(
        pluginName,
        idx,
        tag,
        true // breakpoints
      );

      // Store snapshot
      await this.snapshotStorage.saveSnapshot(pluginName, idx, snapshot);

      // Commit the transaction
      await this.db.execute(sql`COMMIT`);

      logger.info({ src: 'plugin:sql', pluginName, tag }, 'Recorded migration');
    } catch (error) {
      // Rollback on error if transaction was started
      if (transactionStarted) {
        try {
          await this.db.execute(sql`ROLLBACK`);
          logger.error(
            { src: 'plugin:sql', error: error instanceof Error ? error.message : String(error) },
            'Migration failed, rolled back'
          );
        } catch (rollbackError) {
          logger.error(
            {
              src: 'plugin:sql',
              error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            },
            'Failed to rollback transaction'
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
    // Generate a simple tag - in production, use Drizzle's word generation
    const prefix = idx.toString().padStart(4, '0');
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
    lastMigration: any;
    journal: any;
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
    logger.warn({ src: 'plugin:sql', pluginName }, 'Resetting migrations');

    await this.db.execute(
      sql`DELETE FROM migrations._migrations WHERE plugin_name = ${pluginName}`
    );
    await this.db.execute(sql`DELETE FROM migrations._journal WHERE plugin_name = ${pluginName}`);
    await this.db.execute(sql`DELETE FROM migrations._snapshots WHERE plugin_name = ${pluginName}`);

    logger.warn({ src: 'plugin:sql', pluginName }, 'Reset complete');
  }

  /**
   * Check if a migration would cause data loss without executing it
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema to check
   * @returns Data loss analysis or null if no changes
   */
  async checkMigration(pluginName: string, schema: any): Promise<DataLossCheck | null> {
    try {
      logger.info({ src: 'plugin:sql', pluginName }, 'Checking migration');

      // Generate current snapshot from schema
      const currentSnapshot = await generateSnapshot(schema);

      // Load previous snapshot
      const previousSnapshot = await this.snapshotStorage.getLatestSnapshot(pluginName);

      // Check if there are changes
      if (!hasChanges(previousSnapshot, currentSnapshot)) {
        logger.info({ src: 'plugin:sql', pluginName }, 'No changes detected');
        return null;
      }

      // Calculate diff
      const diff = await calculateDiff(previousSnapshot, currentSnapshot);

      // Check for data loss
      const dataLossCheck = checkForDataLoss(diff);

      if (dataLossCheck.hasDataLoss) {
        logger.warn({ src: 'plugin:sql', pluginName }, 'Migration would cause data loss');
      } else {
        logger.info({ src: 'plugin:sql', pluginName }, 'Migration is safe (no data loss)');
      }

      return dataLossCheck;
    } catch (error) {
      logger.error(
        {
          src: 'plugin:sql',
          pluginName,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to check migration'
      );
      throw error;
    }
  }
}
