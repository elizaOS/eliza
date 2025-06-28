import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { logger } from '@elizaos/core';
import type { MigrationResult, ExecutedOperation } from './migration-executor';
import type { MigrationOperation } from './alter-statement-generator';

type DrizzleDB = NodePgDatabase | PgliteDatabase;

export interface MigrationHistoryEntry {
  id: string;
  pluginName: string;
  executedAt: Date;
  operations: MigrationOperation[];
  success: boolean;
  error?: string;
  rollbackSql?: string[];
  executionTimeMs: number;
  operationsExecuted: number;
  operationsFailed: number;
}

export interface RollbackOperation {
  originalOperation: MigrationOperation;
  rollbackSql: string;
  isDestructive: boolean;
  description: string;
}

/**
 * MigrationHistoryManager tracks migration execution history and provides
 * rollback capabilities for supported operations
 */
export class MigrationHistoryManager {
  private static readonly HISTORY_TABLE = '__eliza_migrations__';
  private static readonly SCHEMA_NAME = 'public';

  constructor(private db: DrizzleDB) {}

  /**
   * Initializes the migration history tracking system
   */
  async initialize(): Promise<void> {
    logger.debug('[MIGRATION HISTORY] Initializing migration history tracking');

    try {
      await this.createHistoryTableIfNotExists();
      logger.info('[MIGRATION HISTORY] Migration history tracking initialized');
    } catch (error) {
      logger.error('[MIGRATION HISTORY] Failed to initialize migration history:', error);
      throw error;
    }
  }

  /**
   * Records a completed migration in the history
   */
  async recordMigration(
    pluginName: string,
    result: MigrationResult,
    operations: MigrationOperation[]
  ): Promise<string> {
    const id = this.generateMigrationId();

    try {
      // Generate rollback SQL for successful operations
      const rollbackSql = this.generateRollbackSql(result.executedOperations);

      const entry: MigrationHistoryEntry = {
        id,
        pluginName,
        executedAt: new Date(),
        operations,
        success: result.success,
        error: result.error,
        rollbackSql,
        executionTimeMs: result.duration,
        operationsExecuted: result.executedOperations.length,
        operationsFailed: result.failedOperations.length,
      };

      await this.insertHistoryEntry(entry);

      logger.info(`[MIGRATION HISTORY] Recorded migration ${id} for plugin ${pluginName}`);
      return id;
    } catch (error) {
      logger.error('[MIGRATION HISTORY] Failed to record migration:', error);
      throw error;
    }
  }

  /**
   * Retrieves migration history for a specific plugin
   */
  async getPluginHistory(pluginName: string, limit: number = 10): Promise<MigrationHistoryEntry[]> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT * FROM "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}"
          WHERE plugin_name = '${pluginName}'
          ORDER BY executed_at DESC
          LIMIT ${limit}
        `)
      );

      return (result.rows as any[]).map((row) => this.mapRowToHistoryEntry(row));
    } catch (error) {
      logger.error(`[MIGRATION HISTORY] Failed to get history for plugin ${pluginName}:`, error);
      return [];
    }
  }

  /**
   * Retrieves complete migration history
   */
  async getAllHistory(limit: number = 50): Promise<MigrationHistoryEntry[]> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT * FROM "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}"
          ORDER BY executed_at DESC
          LIMIT ${limit}
        `)
      );

      return (result.rows as any[]).map((row) => this.mapRowToHistoryEntry(row));
    } catch (error) {
      logger.error('[MIGRATION HISTORY] Failed to get migration history:', error);
      return [];
    }
  }

  /**
   * Gets the last successful migration for a plugin
   */
  async getLastSuccessfulMigration(pluginName: string): Promise<MigrationHistoryEntry | null> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT * FROM "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}"
          WHERE plugin_name = '${pluginName}' AND success = true
          ORDER BY executed_at DESC
          LIMIT 1
        `)
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToHistoryEntry(result.rows[0] as any);
    } catch (error) {
      logger.error(
        `[MIGRATION HISTORY] Failed to get last successful migration for ${pluginName}:`,
        error
      );
      return null;
    }
  }

  /**
   * Attempts to rollback a specific migration
   */
  async rollbackMigration(
    migrationId: string,
    options: { force?: boolean } = {}
  ): Promise<boolean> {
    logger.info(`[MIGRATION HISTORY] Attempting to rollback migration ${migrationId}`);

    try {
      // Get the migration entry
      const entry = await this.getMigrationById(migrationId);
      if (!entry) {
        logger.error(`[MIGRATION HISTORY] Migration ${migrationId} not found`);
        return false;
      }

      if (!entry.success) {
        logger.warn(`[MIGRATION HISTORY] Cannot rollback failed migration ${migrationId}`);
        return false;
      }

      if (!entry.rollbackSql || entry.rollbackSql.length === 0) {
        logger.warn(`[MIGRATION HISTORY] No rollback SQL available for migration ${migrationId}`);
        return false;
      }

      // Execute rollback operations in reverse order
      const rollbackOperations = entry.rollbackSql.reverse();
      let rollbackSuccess = true;

      for (const [index, rollbackSql] of rollbackOperations.entries()) {
        try {
          logger.debug(
            `[MIGRATION HISTORY] Executing rollback ${index + 1}/${rollbackOperations.length}: ${rollbackSql}`
          );
          await this.db.execute(sql.raw(rollbackSql));
        } catch (error) {
          logger.error(`[MIGRATION HISTORY] Rollback operation failed: ${rollbackSql}`, error);
          rollbackSuccess = false;

          if (!options.force) {
            break;
          }
        }
      }

      if (rollbackSuccess) {
        // Mark the original migration as rolled back
        await this.markMigrationAsRolledBack(migrationId);
        logger.info(`[MIGRATION HISTORY] Successfully rolled back migration ${migrationId}`);
      } else {
        logger.error(`[MIGRATION HISTORY] Rollback of migration ${migrationId} partially failed`);
      }

      return rollbackSuccess;
    } catch (error) {
      logger.error(`[MIGRATION HISTORY] Rollback failed for migration ${migrationId}:`, error);
      return false;
    }
  }

  /**
   * Generates rollback SQL for executed operations
   */
  private generateRollbackSql(executedOperations: ExecutedOperation[]): string[] {
    const rollbackSql: string[] = [];

    // Process operations in reverse order for rollback
    for (const executed of executedOperations.reverse()) {
      const rollback = this.generateOperationRollback(executed.operation);
      if (rollback) {
        rollbackSql.push(rollback);
      }
    }

    return rollbackSql;
  }

  /**
   * Generates rollback SQL for a single operation
   */
  private generateOperationRollback(operation: MigrationOperation): string | null {
    const sql = operation.sql.toUpperCase();

    try {
      // CREATE TABLE rollback
      if (operation.type === 'CREATE_TABLE') {
        const tableMatch = operation.sql.match(
          /CREATE\s+TABLE\s+"?([^"\s().]+)"?\."?([^"\s().]+)"?/i
        );
        if (tableMatch) {
          return `DROP TABLE IF EXISTS "${tableMatch[1]}"."${tableMatch[2]}"`;
        }
      }

      // CREATE INDEX rollback
      if (operation.type === 'CREATE_INDEX') {
        const indexMatch = operation.sql.match(
          /CREATE\s+(?:UNIQUE\s+)?INDEX\s+"?([^"\s]+)"?\s+ON/i
        );
        if (indexMatch) {
          return `DROP INDEX IF EXISTS "${indexMatch[1]}"`;
        }
      }

      // ADD COLUMN rollback
      if (sql.includes('ADD COLUMN')) {
        const match = operation.sql.match(
          /ALTER\s+TABLE\s+"?([^"]+)"?\."?([^"]+)"?\s+ADD\s+COLUMN\s+"?([^"\s]+)"?/i
        );
        if (match) {
          return `ALTER TABLE "${match[1]}"."${match[2]}" DROP COLUMN IF EXISTS "${match[3]}"`;
        }
      }

      // CREATE CONSTRAINT rollback
      if (operation.type === 'CREATE_CONSTRAINT') {
        const constraintMatch = operation.sql.match(/ADD\s+CONSTRAINT\s+"?([^"]+)"?/i);
        const tableMatch = operation.sql.match(/ALTER\s+TABLE\s+"?([^"]+)"?\."?([^"]+)"?/i);
        if (constraintMatch && tableMatch) {
          return `ALTER TABLE "${tableMatch[1]}"."${tableMatch[2]}" DROP CONSTRAINT IF EXISTS "${constraintMatch[1]}"`;
        }
      }

      // For other operations, we can't safely generate automatic rollbacks
      logger.debug(
        `[MIGRATION HISTORY] Cannot generate rollback for operation: ${operation.description}`
      );
      return null;
    } catch (error) {
      logger.warn(
        `[MIGRATION HISTORY] Failed to generate rollback for operation: ${operation.description}`,
        error
      );
      return null;
    }
  }

  /**
   * Creates the migration history table if it doesn't exist
   */
  private async createHistoryTableIfNotExists(): Promise<void> {
    const createTableSql = `
      CREATE TABLE IF NOT EXISTS "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}" (
        id VARCHAR(255) PRIMARY KEY,
        plugin_name VARCHAR(255) NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
        operations JSONB NOT NULL,
        success BOOLEAN NOT NULL,
        error TEXT,
        rollback_sql JSONB,
        execution_time_ms INTEGER NOT NULL,
        operations_executed INTEGER NOT NULL,
        operations_failed INTEGER NOT NULL,
        rolled_back BOOLEAN DEFAULT FALSE,
        rolled_back_at TIMESTAMP WITH TIME ZONE
      )
    `;

    await this.db.execute(sql.raw(createTableSql));

    // Create index for faster queries
    const indexSql = `
      CREATE INDEX IF NOT EXISTS idx_eliza_migrations_plugin_time 
      ON "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}" (plugin_name, executed_at DESC)
    `;

    await this.db.execute(sql.raw(indexSql));
  }

  /**
   * Inserts a migration history entry
   */
  private async insertHistoryEntry(entry: MigrationHistoryEntry): Promise<void> {
    const insertSql = `
      INSERT INTO "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}" 
      (id, plugin_name, executed_at, operations, success, error, rollback_sql, execution_time_ms, operations_executed, operations_failed)
      VALUES (
        '${entry.id}',
        '${entry.pluginName}',
        '${entry.executedAt.toISOString()}',
        '${JSON.stringify(entry.operations).replace(/'/g, "''")}',
        ${entry.success},
        ${entry.error ? `'${entry.error.replace(/'/g, "''")}'` : 'NULL'},
        '${JSON.stringify(entry.rollbackSql || []).replace(/'/g, "''")}',
        ${entry.executionTimeMs},
        ${entry.operationsExecuted},
        ${entry.operationsFailed}
      )
    `;

    await this.db.execute(sql.raw(insertSql));
  }

  /**
   * Retrieves a migration by ID
   */
  private async getMigrationById(migrationId: string): Promise<MigrationHistoryEntry | null> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT * FROM "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}"
          WHERE id = '${migrationId}'
        `)
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.mapRowToHistoryEntry(result.rows[0] as any);
    } catch (error) {
      logger.error(`[MIGRATION HISTORY] Failed to get migration ${migrationId}:`, error);
      return null;
    }
  }

  /**
   * Marks a migration as rolled back
   */
  private async markMigrationAsRolledBack(migrationId: string): Promise<void> {
    const updateSql = `
      UPDATE "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}"
      SET rolled_back = true, rolled_back_at = NOW()
      WHERE id = '${migrationId}'
    `;

    await this.db.execute(sql.raw(updateSql));
  }

  /**
   * Maps database row to MigrationHistoryEntry object
   */
  private mapRowToHistoryEntry(row: any): MigrationHistoryEntry {
    return {
      id: row.id,
      pluginName: row.plugin_name,
      executedAt: new Date(row.executed_at),
      operations: JSON.parse(row.operations || '[]'),
      success: row.success,
      error: row.error,
      rollbackSql: JSON.parse(row.rollback_sql || '[]'),
      executionTimeMs: row.execution_time_ms,
      operationsExecuted: row.operations_executed,
      operationsFailed: row.operations_failed,
    };
  }

  /**
   * Generates a unique migration ID
   */
  private generateMigrationId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `migration_${timestamp}_${random}`;
  }

  /**
   * Cleans up old migration history entries
   */
  async cleanupOldHistory(keepDays: number = 90): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - keepDays);

      const result = await this.db.execute(
        sql.raw(`
          DELETE FROM "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}"
          WHERE executed_at < '${cutoffDate.toISOString()}'
          AND rolled_back = false
        `)
      );

      const deletedCount = (result as any).rowCount || (result as any).affectedRows || 0;
      logger.info(`[MIGRATION HISTORY] Cleaned up ${deletedCount} old migration entries`);

      return deletedCount;
    } catch (error) {
      logger.error('[MIGRATION HISTORY] Failed to cleanup old history:', error);
      return 0;
    }
  }

  /**
   * Gets migration statistics
   */
  async getStatistics(): Promise<{
    totalMigrations: number;
    successfulMigrations: number;
    failedMigrations: number;
    rolledBackMigrations: number;
    averageExecutionTime: number;
  }> {
    try {
      const result = await this.db.execute(
        sql.raw(`
          SELECT 
            COUNT(*) as total_migrations,
            COUNT(CASE WHEN success = true THEN 1 END) as successful_migrations,
            COUNT(CASE WHEN success = false THEN 1 END) as failed_migrations,
            COUNT(CASE WHEN rolled_back = true THEN 1 END) as rolled_back_migrations,
            AVG(execution_time_ms) as avg_execution_time
          FROM "${MigrationHistoryManager.SCHEMA_NAME}"."${MigrationHistoryManager.HISTORY_TABLE}"
        `)
      );

      const row = result.rows[0] as any;

      return {
        totalMigrations: parseInt(row.total_migrations) || 0,
        successfulMigrations: parseInt(row.successful_migrations) || 0,
        failedMigrations: parseInt(row.failed_migrations) || 0,
        rolledBackMigrations: parseInt(row.rolled_back_migrations) || 0,
        averageExecutionTime: parseFloat(row.avg_execution_time) || 0,
      };
    } catch (error) {
      logger.error('[MIGRATION HISTORY] Failed to get statistics:', error);
      return {
        totalMigrations: 0,
        successfulMigrations: 0,
        failedMigrations: 0,
        rolledBackMigrations: 0,
        averageExecutionTime: 0,
      };
    }
  }
}
