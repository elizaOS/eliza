import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { logger } from '@elizaos/core';
import type { MigrationPlan, MigrationOptions } from './migration-planner';
import type { MigrationOperation } from './alter-statement-generator';

type DrizzleDB = NodePgDatabase | PgliteDatabase;

export interface MigrationResult {
  success: boolean;
  executedOperations: ExecutedOperation[];
  failedOperations: FailedOperation[];
  duration: number; // in milliseconds
  error?: string;
  rollbackPerformed?: boolean;
}

export interface ExecutedOperation {
  operation: MigrationOperation;
  executionTime: number; // in milliseconds
  rowsAffected?: number;
}

export interface FailedOperation {
  operation: MigrationOperation;
  error: string;
  executionTime: number; // in milliseconds
}

export interface DryRunResult {
  wouldExecute: MigrationOperation[];
  estimatedDuration: number;
  potentialIssues: string[];
  summary: string;
}

/**
 * MigrationExecutor handles the actual execution of migration plans
 * with support for transactions, dry-runs, and rollback capabilities
 */
export class MigrationExecutor {
  constructor(private db: DrizzleDB) {}

  /**
   * Executes a migration plan with the specified options
   */
  async executePlan(plan: MigrationPlan, options: MigrationOptions = {}): Promise<MigrationResult> {
    const startTime = Date.now();

    logger.info(
      `[MIGRATION EXECUTOR] Starting migration execution with ${plan.operations.length} operations`
    );

    if (options.dryRun) {
      return this.performDryRun(plan);
    }

    // Validate plan if not skipped
    if (!options.skipValidation) {
      const validationErrors = await this.validatePlanForExecution(plan);
      if (validationErrors.length > 0) {
        return {
          success: false,
          executedOperations: [],
          failedOperations: [],
          duration: Date.now() - startTime,
          error: `Validation failed: ${validationErrors.join('; ')}`,
        };
      }
    }

    // Check if confirmation is required
    if (!options.force && plan.requiresConfirmation && !options.interactive) {
      return {
        success: false,
        executedOperations: [],
        failedOperations: [],
        duration: Date.now() - startTime,
        error:
          'Migration requires confirmation but interactive mode is not enabled. Use force option to bypass.',
      };
    }

    // Group operations by transaction compatibility
    const operationGroups = this.groupOperationsByTransactionCompatibility(plan.operations);

    const result: MigrationResult = {
      success: true,
      executedOperations: [],
      failedOperations: [],
      duration: 0,
    };

    try {
      for (const group of operationGroups) {
        if (group.useTransaction) {
          await this.executeInTransaction(group.operations, result, options);
        } else {
          await this.executeWithoutTransaction(group.operations, result, options);
        }

        // Stop if any operation failed and we're not in force mode
        if (result.failedOperations.length > 0 && !options.force) {
          result.success = false;
          break;
        }
      }
    } catch (error) {
      result.success = false;
      result.error = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('[MIGRATION EXECUTOR] Migration execution failed:', error);
    }

    result.duration = Date.now() - startTime;

    if (result.success) {
      logger.info(`[MIGRATION EXECUTOR] Migration completed successfully in ${result.duration}ms`);
    } else {
      logger.error(`[MIGRATION EXECUTOR] Migration failed after ${result.duration}ms`);
    }

    return result;
  }

  /**
   * Performs a dry run of the migration plan
   */
  private async performDryRun(plan: MigrationPlan): Promise<MigrationResult> {
    logger.info('[MIGRATION EXECUTOR] Performing dry run');

    const dryRunResult: DryRunResult = {
      wouldExecute: plan.operations,
      estimatedDuration: plan.estimatedDuration * 1000, // Convert to milliseconds
      potentialIssues: [],
      summary: this.generateDryRunSummary(plan),
    };

    // Analyze potential issues
    for (const operation of plan.operations) {
      if (operation.isDestructive) {
        dryRunResult.potentialIssues.push(
          `${operation.description} - This operation may cause data loss`
        );
      }

      if (this.isRiskyOperation(operation)) {
        dryRunResult.potentialIssues.push(
          `${operation.description} - This operation carries additional risks`
        );
      }
    }

    logger.info('[MIGRATION EXECUTOR] Dry run completed');
    logger.info(`Would execute ${dryRunResult.wouldExecute.length} operations`);
    logger.info(`Estimated duration: ${dryRunResult.estimatedDuration}ms`);

    if (dryRunResult.potentialIssues.length > 0) {
      logger.warn('Potential issues found:');
      dryRunResult.potentialIssues.forEach((issue) => logger.warn(`  - ${issue}`));
    }

    return {
      success: true,
      executedOperations: [],
      failedOperations: [],
      duration: 0,
    };
  }

  /**
   * Executes operations within a transaction
   */
  private async executeInTransaction(
    operations: MigrationOperation[],
    result: MigrationResult,
    _options: MigrationOptions
  ): Promise<void> {
    logger.debug(`[MIGRATION EXECUTOR] Executing ${operations.length} operations in transaction`);

    try {
      // Use a transaction-like approach (note: Drizzle's transaction support varies by database)
      for (const operation of operations) {
        const opStartTime = Date.now();

        try {
          logger.debug(`[MIGRATION EXECUTOR] Executing: ${operation.description}`);
          logger.debug(`[MIGRATION EXECUTOR] SQL: ${operation.sql}`);

          // Execute the SQL
          const sqlResult = await this.db.execute(sql.raw(operation.sql));

          const executionTime = Date.now() - opStartTime;

          result.executedOperations.push({
            operation,
            executionTime,
            rowsAffected: this.extractRowCount(sqlResult),
          });

          logger.debug(
            `[MIGRATION EXECUTOR] Completed: ${operation.description} (${executionTime}ms)`
          );
        } catch (error) {
          const executionTime = Date.now() - opStartTime;
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';

          // Check for unsupported features that should trigger fallback
          if (this.isUnsupportedFeatureError(errorMessage)) {
            logger.warn(
              `[MIGRATION EXECUTOR] Unsupported feature detected: ${errorMessage}. Consider using fallback migration.`
            );
          }

          result.failedOperations.push({
            operation,
            error: errorMessage,
            executionTime,
          });

          logger.error(`[MIGRATION EXECUTOR] Failed: ${operation.description} - ${errorMessage}`);

          // In a transaction, we would normally rollback here
          // For now, we'll just throw to stop execution
          throw error;
        }
      }
    } catch (error) {
      // Transaction rollback would happen here
      logger.error('[MIGRATION EXECUTOR] Transaction failed, operations may need manual rollback');
      throw error;
    }
  }

  /**
   * Executes operations without transaction (for DDL operations that can't be in transactions)
   */
  private async executeWithoutTransaction(
    operations: MigrationOperation[],
    result: MigrationResult,
    options: MigrationOptions
  ): Promise<void> {
    logger.debug(
      `[MIGRATION EXECUTOR] Executing ${operations.length} operations without transaction`
    );

    for (const operation of operations) {
      const opStartTime = Date.now();

      try {
        logger.debug(`[MIGRATION EXECUTOR] Executing: ${operation.description}`);
        logger.debug(`[MIGRATION EXECUTOR] SQL: ${operation.sql}`);

        // Add a small delay for operations that might conflict
        if (this.needsDelay(operation)) {
          await this.delay(100);
        }

        const sqlResult = await this.db.execute(sql.raw(operation.sql));

        const executionTime = Date.now() - opStartTime;

        result.executedOperations.push({
          operation,
          executionTime,
          rowsAffected: this.extractRowCount(sqlResult),
        });

        logger.debug(
          `[MIGRATION EXECUTOR] Completed: ${operation.description} (${executionTime}ms)`
        );
      } catch (error) {
        const executionTime = Date.now() - opStartTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        result.failedOperations.push({
          operation,
          error: errorMessage,
          executionTime,
        });

        logger.error(`[MIGRATION EXECUTOR] Failed: ${operation.description} - ${errorMessage}`);

        // For non-transactional operations, we continue unless force is disabled
        if (!options.force) {
          throw new Error(`Migration failed at operation: ${operation.description}`);
        }
      }
    }
  }

  /**
   * Groups operations by whether they can be executed in a transaction
   */
  private groupOperationsByTransactionCompatibility(operations: MigrationOperation[]): Array<{
    operations: MigrationOperation[];
    useTransaction: boolean;
  }> {
    const groups: Array<{ operations: MigrationOperation[]; useTransaction: boolean }> = [];
    let currentGroup: MigrationOperation[] = [];
    let currentGroupUsesTransaction = true;

    for (const operation of operations) {
      const canUseTransaction = this.canUseTransaction(operation);

      if (canUseTransaction !== currentGroupUsesTransaction) {
        // Start a new group
        if (currentGroup.length > 0) {
          groups.push({
            operations: [...currentGroup],
            useTransaction: currentGroupUsesTransaction,
          });
        }
        currentGroup = [operation];
        currentGroupUsesTransaction = canUseTransaction;
      } else {
        currentGroup.push(operation);
      }
    }

    // Add the last group
    if (currentGroup.length > 0) {
      groups.push({
        operations: currentGroup,
        useTransaction: currentGroupUsesTransaction,
      });
    }

    return groups;
  }

  /**
   * Determines if an operation can be executed within a transaction
   */
  private canUseTransaction(operation: MigrationOperation): boolean {
    // Most DDL operations in PostgreSQL can be in transactions
    // Some specific operations like CREATE DATABASE cannot

    const sql = operation.sql.toUpperCase();

    // Operations that cannot be in transactions
    if (
      sql.includes('CREATE DATABASE') ||
      sql.includes('DROP DATABASE') ||
      sql.includes('CREATE TABLESPACE') ||
      sql.includes('DROP TABLESPACE')
    ) {
      return false;
    }

    // Most other operations can be in transactions
    return true;
  }

  /**
   * Validates that the plan can be executed safely
   */
  private async validatePlanForExecution(plan: MigrationPlan): Promise<string[]> {
    const errors: string[] = [];

    // Check database connectivity
    try {
      await this.db.execute(sql.raw('SELECT 1'));
    } catch (error) {
      errors.push('Database connection failed');
      return errors; // Can't continue validation without DB connection
    }

    // Validate each operation
    for (const operation of plan.operations) {
      // Basic SQL validation
      if (!operation.sql || operation.sql.trim().length === 0) {
        errors.push(`Empty SQL in operation: ${operation.description}`);
      }

      // Check for potentially dangerous operations
      if (operation.isDestructive && operation.sql.toUpperCase().includes('DROP TABLE')) {
        errors.push(`Destructive table drop detected: ${operation.description}`);
      }
    }

    return errors;
  }

  /**
   * Checks if an operation is risky and needs special attention
   */
  private isRiskyOperation(operation: MigrationOperation): boolean {
    const sql = operation.sql.toUpperCase();

    return (
      sql.includes('DROP COLUMN') ||
      (sql.includes('ALTER COLUMN') && sql.includes('TYPE')) ||
      sql.includes('DROP TABLE') ||
      (sql.includes('DROP CONSTRAINT') && sql.includes('PRIMARY KEY'))
    );
  }

  /**
   * Determines if an operation needs a delay before execution
   */
  private needsDelay(operation: MigrationOperation): boolean {
    // Add delays for operations that might conflict with concurrent access
    return operation.type === 'CREATE_INDEX' || operation.type === 'ALTER_TABLE';
  }

  /**
   * Utility function to add delays
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Extracts row count from SQL result (if available)
   */
  private extractRowCount(result: any): number | undefined {
    if (result && typeof result === 'object') {
      if ('rowCount' in result) return result.rowCount;
      if ('affectedRows' in result) return result.affectedRows;
      if ('rows' in result && Array.isArray(result.rows)) return result.rows.length;
    }
    return undefined;
  }

  /**
   * Generates a summary for dry run results
   */
  private generateDryRunSummary(plan: MigrationPlan): string {
    const opCounts = plan.operations.reduce(
      (acc, op) => {
        acc[op.type] = (acc[op.type] || 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    );

    const parts = Object.entries(opCounts).map(([type, count]) => `${count} ${type.toLowerCase()}`);

    let summary = `Would execute: ${parts.join(', ')}`;

    if (plan.backupRecommended) {
      summary += '. Backup recommended before execution.';
    }

    if (plan.requiresConfirmation) {
      summary += '. Requires user confirmation.';
    }

    return summary;
  }

  /**
   * Attempts to rollback a failed migration (limited support)
   */
  async attemptRollback(executedOperations: ExecutedOperation[]): Promise<boolean> {
    logger.warn('[MIGRATION EXECUTOR] Attempting migration rollback');

    try {
      // Reverse the operations
      const reversedOps = [...executedOperations].reverse();

      for (const executed of reversedOps) {
        const rollbackSQL = this.generateRollbackSQL(executed.operation);
        if (rollbackSQL) {
          try {
            await this.db.execute(sql.raw(rollbackSQL));
            logger.debug(`[MIGRATION EXECUTOR] Rolled back: ${executed.operation.description}`);
          } catch (error) {
            logger.error(
              `[MIGRATION EXECUTOR] Failed to rollback: ${executed.operation.description}`,
              error
            );
            return false;
          }
        }
      }

      logger.info('[MIGRATION EXECUTOR] Rollback completed successfully');
      return true;
    } catch (error) {
      logger.error('[MIGRATION EXECUTOR] Rollback failed:', error);
      return false;
    }
  }

  /**
   * Generates rollback SQL for an operation (limited support)
   */
  private generateRollbackSQL(operation: MigrationOperation): string | null {
    switch (operation.type) {
      case 'CREATE_TABLE':
        return `DROP TABLE IF EXISTS ${this.extractTableFromSQL(operation.sql)}`;

      case 'CREATE_INDEX': {
        const indexMatch = operation.sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+"?([^"\s]+)"?/i);
        if (indexMatch) {
          return `DROP INDEX IF EXISTS "${indexMatch[1]}"`;
        }
        break;
      }

      case 'CREATE_CONSTRAINT':
        // This is complex as we'd need to know the constraint name and table
        // For now, we can't automatically rollback constraint additions
        return null;

      case 'ALTER_TABLE':
        // ALTER TABLE rollbacks are very complex and operation-specific
        // We can't safely auto-generate these
        return null;

      default:
        return null;
    }

    return null;
  }

  /**
   * Extracts table name from CREATE TABLE SQL
   */
  private extractTableFromSQL(sql: string): string {
    const match = sql.match(/CREATE\s+TABLE\s+"?([^"\s()]+)"?\."?([^"\s()]+)"?/i);
    if (match) {
      return `"${match[1]}"."${match[2]}"`;
    }
    return 'unknown_table';
  }

  /**
   * Checks if an error indicates an unsupported feature that should trigger fallback
   */
  private isUnsupportedFeatureError(errorMessage: string): boolean {
    const unsupportedPatterns = [
      /type "vector" does not exist/i,
      /unknown data type: vector/i,
      /unrecognized data type name "vector"/i,
      /extension .* is not available/i,
      /function .* does not exist/i,
    ];

    return unsupportedPatterns.some((pattern) => pattern.test(errorMessage));
  }
}
