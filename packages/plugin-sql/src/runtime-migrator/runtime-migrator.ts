import { sql } from 'drizzle-orm';
import { logger } from '@elizaos/core';
import type { DrizzleDB, RuntimeMigrationOptions, SchemaSnapshot } from './types';
import { MigrationTracker } from './storage/migration-tracker';
import { JournalStorage } from './storage/journal-storage';
import { SnapshotStorage } from './storage/snapshot-storage';
import { ExtensionManager } from './extension-manager';
import { generateSnapshot, hashSnapshot, hasChanges } from './drizzle-adapters/snapshot-generator';
import { calculateDiff, hasDiffChanges } from './drizzle-adapters/diff-calculator';
import { generateMigrationSQL } from './drizzle-adapters/sql-generator';

export class RuntimeMigrator {
  private migrationTracker: MigrationTracker;
  private journalStorage: JournalStorage;
  private snapshotStorage: SnapshotStorage;
  private extensionManager: ExtensionManager;

  constructor(private db: DrizzleDB) {
    this.migrationTracker = new MigrationTracker(db);
    this.journalStorage = new JournalStorage(db);
    this.snapshotStorage = new SnapshotStorage(db);
    this.extensionManager = new ExtensionManager(db);
  }

  /**
   * Initialize migration system - create necessary tables
   */
  async initialize(): Promise<void> {
    logger.info('[RuntimeMigrator] Initializing migration system...');
    await this.migrationTracker.ensureTables();
    logger.info('[RuntimeMigrator] Migration system initialized');
  }

  /**
   * Run migrations for a plugin/schema
   */
  async migrate(
    pluginName: string,
    schema: any,
    options: RuntimeMigrationOptions = {}
  ): Promise<void> {
    try {
      logger.info(`[RuntimeMigrator] Starting migration for plugin: ${pluginName}`);

      // Ensure migration tables exist
      await this.initialize();

      // Install required extensions (same as old migrator)
      await this.extensionManager.installRequiredExtensions(['vector', 'fuzzystrmatch']);

      // Generate current snapshot from schema
      const currentSnapshot = await generateSnapshot(schema);
      const currentHash = hashSnapshot(currentSnapshot);

      // Check if we've already run this exact migration
      const lastMigration = await this.migrationTracker.getLastMigration(pluginName);
      if (lastMigration && lastMigration.hash === currentHash) {
        logger.info(`[RuntimeMigrator] No changes detected for ${pluginName}, skipping migration`);
        return;
      }

      // Load previous snapshot
      const previousSnapshot = await this.snapshotStorage.getLatestSnapshot(pluginName);

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
    } catch (error) {
      logger.error(`[RuntimeMigrator] Migration failed for ${pluginName}:`, JSON.stringify(error));
      throw error;
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
    // Check if we can use transactions (PostgreSQL) or need to execute directly (PGLite)
    const isPGLite = this.checkIfPGLite();

    if (isPGLite) {
      // PGLite doesn't support Drizzle transactions the same way
      // Execute statements directly with manual transaction control
      try {
        // Start manual transaction for PGLite
        await this.db.execute(sql`BEGIN`);

        try {
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
          // Rollback on error
          await this.db.execute(sql`ROLLBACK`);
          logger.error(
            '[RuntimeMigrator] Migration failed, rolled back:',
            JSON.stringify(error as any)
          );
          throw error;
        }
      } catch (error) {
        logger.error(
          '[RuntimeMigrator] Migration transaction failed:',
          JSON.stringify(error as any)
        );
        throw error;
      }
    } else {
      // Use Drizzle transaction for PostgreSQL
      await (this.db as any).transaction(async (tx: DrizzleDB) => {
        try {
          // Execute all SQL statements
          for (const stmt of sqlStatements) {
            logger.debug(`[RuntimeMigrator] Executing: ${stmt}`);
            await tx.execute(sql.raw(stmt));
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

          logger.info(`[RuntimeMigrator] Recorded migration ${tag} for ${pluginName}`);
        } catch (error) {
          // Transaction will automatically rollback
          logger.error(
            '[RuntimeMigrator] Migration transaction failed:',
            JSON.stringify(error as any)
          );
          throw error;
        }
      });
    }
  }

  /**
   * Check if the database is PGLite
   */
  private checkIfPGLite(): boolean {
    // Check if the db object has a transaction method
    // PGLite's drizzle adapter might not have it or it might throw
    try {
      // Check if db has the transaction method and if it's a function
      if (typeof (this.db as any).transaction !== 'function') {
        return true; // No transaction method, likely PGLite
      }

      // Additional check: see if we can detect PGLite specific properties
      // PGLite connections often have specific markers
      const dbString = JSON.stringify(this.db);
      if (dbString.includes('PGlite') || dbString.includes('pglite')) {
        return true;
      }

      return false; // Assume it's regular PostgreSQL
    } catch {
      // If checking causes an error, assume it's PGLite
      return true;
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
}
