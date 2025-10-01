import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB, RuntimeMigrationOptions, SchemaSnapshot } from './types';
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
      logger.debug(`[RuntimeMigrator] Ensuring schema '${schemaName}' exists`);
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
          `[RuntimeMigrator] WARNING: Plugin '${pluginName}' table '${tableData.name}' is using public schema. ` +
            `Consider using pgSchema('${expectedSchema}').table(...) for better isolation.`
        );
      }

      // Warn if core plugin is not using public schema
      if (isCorePLugin && actualSchema !== 'public') {
        logger.warn(
          `[RuntimeMigrator] WARNING: Core plugin '@elizaos/plugin-sql' table '${tableData.name}' is using schema '${actualSchema}'. ` +
            `Core tables should use public schema.`
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
   *
   * This method handles various connection string formats including:
   * - Standard postgres:// and postgresql:// URLs
   * - Cloud provider URLs (AWS, Azure, GCP, Supabase, Neon, etc.)
   * - Connection strings with query parameters
   * - Non-standard schemes (pgbouncer://, etc.)
   * - IP addresses with ports
   *
   * @param connectionUrl - Database connection string to check
   * @returns true if this is a real PostgreSQL database connection
   */
  private isRealPostgresDatabase(connectionUrl: string): boolean {
    // Empty or undefined URL means not PostgreSQL
    if (!connectionUrl || connectionUrl.trim() === '') {
      return false;
    }

    // Trim and then convert to lowercase for consistent pattern matching
    const trimmedUrl = connectionUrl.trim();
    const url = trimmedUrl.toLowerCase();
    const originalUrl = trimmedUrl; // Preserve case for pattern matching

    // First, explicitly reject other database schemes
    // These are non-PostgreSQL databases that should be rejected immediately
    const nonPostgresSchemes = [
      'mysql://',
      'mysqli://',
      'mariadb://',
      'mongodb://',
      'mongodb+srv://',
    ];

    for (const scheme of nonPostgresSchemes) {
      if (url.startsWith(scheme)) {
        return false;
      }
    }

    // Second, check for definitive non-PostgreSQL patterns
    // These patterns indicate PGLite, in-memory, or SQLite databases
    const excludePatterns = [
      ':memory:', // In-memory database
      'pglite://', // PGLite with scheme
      '/pglite', // PGLite path
      'sqlite://', // SQLite with scheme
      'sqlite3://', // SQLite3 with scheme
      '.sqlite', // SQLite file extension
      '.sqlite3', // SQLite3 file extension
      'file::memory:', // SQLite in-memory with file scheme
      'file:', // File-based database (when not followed by // for URL schemes)
    ];

    // Check for file extensions at the end of the URL (before query params)
    const urlWithoutQuery = url.split('?')[0];
    if (
      urlWithoutQuery.endsWith('.db') ||
      urlWithoutQuery.endsWith('.sqlite') ||
      urlWithoutQuery.endsWith('.sqlite3')
    ) {
      return false;
    }

    for (const pattern of excludePatterns) {
      if (url.includes(pattern)) {
        // Special case: file:// can be part of a valid postgres URL in some contexts
        if (pattern === 'file:' && url.includes('postgres')) {
          continue;
        }
        return false;
      }
    }

    // Check for PostgreSQL URL schemes (including variations and proxies)
    const postgresSchemes = [
      'postgres://', // Standard PostgreSQL URL scheme
      'postgresql://', // Alternative PostgreSQL URL scheme
      'postgis://', // PostGIS (PostgreSQL with GIS extension)
      'pgbouncer://', // PgBouncer connection pooler
      'pgpool://', // PgPool connection pooler
      'cockroach://', // CockroachDB (PostgreSQL compatible)
      'cockroachdb://', // CockroachDB alternative scheme
      'redshift://', // AWS Redshift (PostgreSQL compatible)
      'timescaledb://', // TimescaleDB (PostgreSQL with time-series)
      'yugabyte://', // YugabyteDB (PostgreSQL compatible)
    ];

    for (const scheme of postgresSchemes) {
      if (url.startsWith(scheme)) {
        return true;
      }
    }

    // Check for PostgreSQL connection string parameters
    // These indicate libpq-style connection strings
    const connectionParams = [
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
    ];

    for (const param of connectionParams) {
      if (url.includes(param)) {
        return true;
      }
    }

    // Check for user@host format (common in PostgreSQL connection strings)
    if (url.includes('@') && (url.includes('postgres') || /:\d{4,5}/.test(url))) {
      return true;
    }

    // Check for common PostgreSQL ports
    const postgresPorts = [
      ':5432', // Default PostgreSQL port
      ':5433', // Common alternative PostgreSQL port
      ':5434', // Another common alternative
      ':25060', // DigitalOcean Managed Databases default port
      ':26257', // CockroachDB default port
      ':6432', // PgBouncer default port
      ':9999', // PgPool default port
      ':8432', // Supabase Pooler port
    ];

    for (const port of postgresPorts) {
      if (url.includes(port)) {
        return true;
      }
    }

    // Check for cloud provider hostnames and patterns
    const cloudProviderPatterns = [
      // AWS
      'amazonaws.com',
      'rds.amazonaws.com',
      '.rds.',
      'redshift.amazonaws.com',
      // Azure
      'azure.com',
      'database.azure.com',
      'postgres.database.azure.com',
      // Google Cloud
      'googleusercontent',
      'cloudsql',
      'cloud.google.com',
      // Supabase
      'supabase',
      '.supabase.co',
      '.supabase.com',
      'pooler.supabase',
      // Neon
      'neon.tech',
      '.neon.tech',
      'neon.build',
      // Railway
      'railway.app',
      '.railway.app',
      'railway.internal',
      // Render
      'render.com',
      '.render.com',
      'onrender.com',
      // Heroku
      'heroku.com',
      'herokuapp.com',
      '.heroku.com',
      // TimescaleDB
      'timescale',
      'timescaledb',
      '.tsdb.cloud',
      // CockroachDB
      'cockroachlabs',
      'cockroachdb.cloud',
      '.crdb.io',
      // DigitalOcean
      'digitalocean.com',
      'db.ondigitalocean',
      'do-user-',
      '.db.ondigitalocean.com',
      // Aiven
      'aiven',
      'aivencloud',
      '.aiven.io',
      '.aivencloud.com',
      // Crunchy Data
      'crunchydata',
      '.crunchydata.com',
      // ElephantSQL
      'elephantsql',
      '.elephantsql.com',
      // YugabyteDB
      'yugabyte',
      '.yugabyte.cloud',
      // Scaleway
      'scaleway',
      '.rdb.fr-par.scw.cloud',
      // Vercel Postgres
      'vercel-storage',
      '.postgres.vercel-storage.com',
      // PlanetScale (supports PostgreSQL wire protocol)
      'psdb.cloud',
      '.psdb.cloud',
      // Xata
      'xata.sh',
      '.xata.sh',
      // Fly.io
      'fly.dev',
      '.fly.dev',
      'fly.io',
    ];

    for (const pattern of cloudProviderPatterns) {
      if (url.includes(pattern)) {
        return true;
      }
    }

    // Check for IP address with port (common for self-hosted or cloud databases)
    // Match IPv4: xxx.xxx.xxx.xxx:port
    const ipv4PortPattern = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{1,5}\b/;
    if (ipv4PortPattern.test(originalUrl)) {
      return true;
    }

    // Check for IPv6 addresses (common in cloud environments)
    // Match [xxxx:xxxx:...:xxxx]:port or similar formats
    const ipv6Pattern = /\[[0-9a-f:]+\](:\d{1,5})?/i;
    if (ipv6Pattern.test(originalUrl)) {
      return true;
    }

    // Check for host:port/database format (without explicit scheme)
    // This pattern matches: "hostname:5432/mydb" or "subdomain.example.com:5432/testdb"
    const hostPortDbPattern = /^[a-z0-9.-]+:\d{1,5}\/[a-z0-9_-]+/i;
    if (hostPortDbPattern.test(originalUrl)) {
      return true;
    }

    // Check for connection strings with query parameters that indicate PostgreSQL
    if (url.includes('?') || url.includes('&')) {
      const postgresQueryParams = [
        'sslmode=',
        'sslcert=',
        'sslkey=',
        'sslrootcert=',
        'connect_timeout=',
        'application_name=',
        'options=',
        'fallback_application_name=',
        'keepalives=',
        'target_session_attrs=',
      ];

      for (const param of postgresQueryParams) {
        if (url.includes(param)) {
          return true;
        }
      }
    }

    // If none of the patterns matched, assume it's not a real PostgreSQL database
    // This is a conservative approach to avoid using advisory locks on unknown databases
    logger.debug(
      `[RuntimeMigrator] Connection string did not match any PostgreSQL patterns: ${url.substring(0, 50)}...`
    );
    return false;
  }

  /**
   * Initialize migration system - create necessary tables
   * @throws Error if table creation fails
   */
  async initialize(): Promise<void> {
    logger.info('[RuntimeMigrator] Initializing migration system...');
    await this.migrationTracker.ensureTables();
    logger.info('[RuntimeMigrator] Migration system initialized');
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
      logger.info(`[RuntimeMigrator] Starting migration for plugin: ${pluginName}`);

      // Ensure migration tables exist
      await this.initialize();

      // Only use advisory locks for real PostgreSQL databases
      // Skip for PGLite or development databases
      const postgresUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
      const isRealPostgres = this.isRealPostgresDatabase(postgresUrl);

      if (isRealPostgres) {
        try {
          logger.debug(`[RuntimeMigrator] Using PostgreSQL advisory locks for ${pluginName}`);

          // Convert bigint to string for SQL query
          // The sql tagged template will properly parameterize this value
          const lockIdStr = lockId.toString();

          const lockResult = await this.db.execute(
            sql`SELECT pg_try_advisory_lock(CAST(${lockIdStr} AS bigint)) as acquired`
          );

          lockAcquired = (lockResult.rows[0] as any)?.acquired === true;

          if (!lockAcquired) {
            logger.info(
              `[RuntimeMigrator] Migration already in progress for ${pluginName}, waiting for lock...`
            );

            // Wait for the lock (blocking call)
            await this.db.execute(sql`SELECT pg_advisory_lock(CAST(${lockIdStr} AS bigint))`);
            lockAcquired = true;

            logger.info(`[RuntimeMigrator] Lock acquired for ${pluginName}`);
          } else {
            logger.debug(
              `[RuntimeMigrator] Advisory lock acquired for ${pluginName} (lock ID: ${lockIdStr})`
            );
          }
        } catch (lockError) {
          // If advisory locks fail, log but continue
          // This might happen if the PostgreSQL version doesn't support advisory locks
          logger.warn(
            `[RuntimeMigrator] Failed to acquire advisory lock, continuing without lock: ${lockError}`
          );
          lockAcquired = false;
        }
      } else {
        // For PGLite or other development databases, skip advisory locks
        logger.debug(
          `[RuntimeMigrator] Development database detected (PGLite or non-PostgreSQL), skipping advisory locks`
        );
      }

      // Install required extensions (same as old migrator)
      await this.extensionManager.installRequiredExtensions(['vector', 'fuzzystrmatch']);

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
          `[RuntimeMigrator] No changes detected for ${pluginName}, skipping migration (hash: ${currentHash})`
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
            `[RuntimeMigrator] No snapshot found for ${pluginName} but tables exist in database. Introspecting...`
          );

          // Determine the schema name for introspection
          const schemaName = this.getExpectedSchemaName(pluginName);

          // Introspect the current database state
          const introspectedSnapshot = await this.introspector.introspectSchema(schemaName);

          // Only use the introspected snapshot if it has tables
          if (Object.keys(introspectedSnapshot.tables).length > 0) {
            // Save this as the initial snapshot (idx: 0)
            await this.snapshotStorage.saveSnapshot(pluginName, 0, introspectedSnapshot);

            // Update journal to record this initial state
            await this.journalStorage.updateJournal(
              pluginName,
              0,
              `introspected_${Date.now()}`,
              true
            );

            // Record this as a migration
            const introspectedHash = hashSnapshot(introspectedSnapshot);
            await this.migrationTracker.recordMigration(pluginName, introspectedHash, Date.now());

            logger.info(
              `[RuntimeMigrator] Created initial snapshot from existing database for ${pluginName}`
            );

            // Set this as the previous snapshot for comparison
            previousSnapshot = introspectedSnapshot;
          }
        }
      }

      // Check if there are actual changes
      if (!hasChanges(previousSnapshot, currentSnapshot)) {
        logger.info(`[RuntimeMigrator] No schema changes for ${pluginName}`);

        // For empty schemas, we still want to record the migration
        // to ensure idempotency and consistency
        if (!previousSnapshot && Object.keys(currentSnapshot.tables).length === 0) {
          logger.info(`[RuntimeMigrator] Recording empty schema for ${pluginName}`);
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
        logger.info(`[RuntimeMigrator] No actionable changes for ${pluginName}`);
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
          logger.error('[RuntimeMigrator] Destructive migration blocked');
          logger.error(`[RuntimeMigrator] Plugin: ${pluginName}`);
          logger.error(
            `[RuntimeMigrator] Environment: ${isProduction ? 'PRODUCTION' : 'DEVELOPMENT'}`
          );
          logger.error('[RuntimeMigrator] Destructive operations detected:');

          for (const warning of dataLossCheck.warnings) {
            logger.error(`[RuntimeMigrator]   - ${warning}`);
          }

          logger.error('[RuntimeMigrator] To proceed with destructive migrations:');
          logger.error(
            '[RuntimeMigrator]   1. Set environment variable: export ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true'
          );
          logger.error(
            '[RuntimeMigrator]   2. Or use option: migrate(plugin, schema, { force: true })'
          );

          if (isProduction) {
            logger.error(
              '[RuntimeMigrator]   3. For production, consider using drizzle-kit for manual migration'
            );
          }

          const errorMessage = isProduction
            ? `Destructive migration blocked in production for ${pluginName}. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true or use drizzle-kit.`
            : `Destructive migration blocked for ${pluginName}. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true to proceed.`;

          throw new Error(errorMessage);
        }

        // Log that we're proceeding with destructive operations
        if (dataLossCheck.requiresConfirmation) {
          logger.warn('[RuntimeMigrator] Proceeding with destructive migration');
          logger.warn(`[RuntimeMigrator] Plugin: ${pluginName}`);
          logger.warn('[RuntimeMigrator] The following operations will be performed:');

          for (const warning of dataLossCheck.warnings) {
            logger.warn(`[RuntimeMigrator]   ⚠️ ${warning}`);
          }
        }
      }

      // Generate SQL statements
      const sqlStatements = await generateMigrationSQL(previousSnapshot, currentSnapshot, diff);

      if (sqlStatements.length === 0) {
        logger.info(`[RuntimeMigrator] No SQL statements to execute for ${pluginName}`);
        return;
      }

      // Log what we're about to do
      logger.info(
        `[RuntimeMigrator] Executing ${sqlStatements.length} SQL statements for ${pluginName}`
      );
      if (options.verbose) {
        sqlStatements.forEach((stmt, i) => {
          logger.debug(`[RuntimeMigrator] Statement ${i + 1}: ${stmt}`);
        });
      }

      // Dry run mode - just log what would happen
      if (options.dryRun) {
        logger.info('[RuntimeMigrator] DRY RUN mode - not executing statements');
        logger.info('[RuntimeMigrator] Would execute:');
        sqlStatements.forEach((stmt, i) => {
          logger.info(`  ${i + 1}. ${stmt}`);
        });
        return;
      }

      // Execute migration in transaction
      await this.executeMigration(pluginName, currentSnapshot, currentHash, sqlStatements);

      logger.info(`[RuntimeMigrator] Migration completed successfully for ${pluginName}`);

      // Return a success result
      return;
    } catch (error) {
      logger.error(`[RuntimeMigrator] Migration failed for ${pluginName}:`, JSON.stringify(error));
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
          logger.debug(`[RuntimeMigrator] Advisory lock released for ${pluginName}`);
        } catch (unlockError) {
          logger.warn(
            `[RuntimeMigrator] Failed to release advisory lock for ${pluginName}:`,
            JSON.stringify(unlockError)
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
        logger.debug(`[RuntimeMigrator] Executing: ${stmt}`);
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

      logger.info(`[RuntimeMigrator] Recorded migration ${tag} for ${pluginName}`);
    } catch (error) {
      // Rollback on error if transaction was started
      if (transactionStarted) {
        try {
          await this.db.execute(sql`ROLLBACK`);
          logger.error(
            '[RuntimeMigrator] Migration failed, rolled back:',
            JSON.stringify(error as any)
          );
        } catch (rollbackError) {
          logger.error(
            '[RuntimeMigrator] Failed to rollback transaction:',
            JSON.stringify(rollbackError as any)
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
    logger.warn(`[RuntimeMigrator] Resetting migrations for ${pluginName}`);

    await this.db.execute(
      sql`DELETE FROM migrations._migrations WHERE plugin_name = ${pluginName}`
    );
    await this.db.execute(sql`DELETE FROM migrations._journal WHERE plugin_name = ${pluginName}`);
    await this.db.execute(sql`DELETE FROM migrations._snapshots WHERE plugin_name = ${pluginName}`);

    logger.warn(`[RuntimeMigrator] Reset complete for ${pluginName}`);
  }

  /**
   * Check if a migration would cause data loss without executing it
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema to check
   * @returns Data loss analysis or null if no changes
   */
  async checkMigration(pluginName: string, schema: any): Promise<DataLossCheck | null> {
    try {
      logger.info(`[RuntimeMigrator] Checking migration for ${pluginName}...`);

      // Generate current snapshot from schema
      const currentSnapshot = await generateSnapshot(schema);

      // Load previous snapshot
      const previousSnapshot = await this.snapshotStorage.getLatestSnapshot(pluginName);

      // Check if there are changes
      if (!hasChanges(previousSnapshot, currentSnapshot)) {
        logger.info(`[RuntimeMigrator] No changes detected for ${pluginName}`);
        return null;
      }

      // Calculate diff
      const diff = await calculateDiff(previousSnapshot, currentSnapshot);

      // Check for data loss
      const dataLossCheck = checkForDataLoss(diff);

      if (dataLossCheck.hasDataLoss) {
        logger.warn(`[RuntimeMigrator] Migration for ${pluginName} would cause data loss`);
      } else {
        logger.info(`[RuntimeMigrator] Migration for ${pluginName} is safe (no data loss)`);
      }

      return dataLossCheck;
    } catch (error) {
      logger.error(
        `[RuntimeMigrator] Failed to check migration for ${pluginName}:`,
        JSON.stringify(error)
      );
      throw error;
    }
  }
}
