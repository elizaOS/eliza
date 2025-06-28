import { logger } from '@elizaos/core';
import type { SchemaDiff } from './schema-diff-engine';
import type { MigrationOperation } from './alter-statement-generator';
import { AlterStatementGenerator } from './alter-statement-generator';
import type { TableDefinition } from './custom-migrator';

export interface MigrationPlan {
  operations: MigrationOperation[];
  warnings: MigrationWarning[];
  requiresConfirmation: boolean;
  estimatedDuration: number; // in seconds
  backupRecommended: boolean;
}

export interface MigrationWarning {
  level: 'info' | 'warning' | 'error';
  message: string;
  operation?: MigrationOperation;
  recommendation?: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  canProceed: boolean;
}

export interface MigrationOptions {
  dryRun?: boolean;
  force?: boolean;
  interactive?: boolean;
  skipValidation?: boolean;
  maxOperationDuration?: number; // in seconds
}

/**
 * MigrationPlanner analyzes schema differences and creates safe, ordered migration plans
 */
export class MigrationPlanner {
  private generator: AlterStatementGenerator;

  constructor() {
    this.generator = new AlterStatementGenerator();
  }

  /**
   * Creates a comprehensive migration plan from schema differences
   */
  async createPlan(diff: SchemaDiff, schemaName: string = 'public'): Promise<MigrationPlan> {
    logger.debug('[MIGRATION PLANNER] Creating migration plan');

    const operations: MigrationOperation[] = [];
    const warnings: MigrationWarning[] = [];

    // Generate operations for table creation
    for (const tableDef of diff.tablesToCreate) {
      operations.push(...this.generateCreateTableOperations(tableDef, schemaName));
    }

    // Generate operations for table alterations
    for (const alteration of diff.tablesToAlter) {
      operations.push(...this.generator.generateAlterTable(alteration, schemaName));
    }

    // Add warnings for tables to drop (but don't generate drop operations)
    for (const tableName of diff.tablesToDrop) {
      warnings.push({
        level: 'warning',
        message: `Table '${tableName}' exists in database but not in schema definition`,
        recommendation:
          'Manual review required. Consider if this table should be dropped or if the schema definition is incomplete.',
      });
    }

    // Analyze the plan for safety
    const planAnalysis = this.analyzePlanSafety(operations);
    warnings.push(...planAnalysis.warnings);

    // Order operations for safe execution
    const orderedOperations = this.orderOperationsForExecution(operations);

    const plan: MigrationPlan = {
      operations: orderedOperations,
      warnings,
      requiresConfirmation: this.requiresConfirmation(orderedOperations, warnings),
      estimatedDuration: this.estimateDuration(orderedOperations),
      backupRecommended: this.recommendsBackup(orderedOperations),
    };

    logger.info(
      `[MIGRATION PLANNER] Created plan with ${plan.operations.length} operations, ${plan.warnings.length} warnings`
    );
    return plan;
  }

  /**
   * Validates a migration plan for safety and consistency
   */
  async validatePlan(plan: MigrationPlan): Promise<ValidationResult> {
    const errors: string[] = [];
    let canProceed = true;

    // Check for critical errors in warnings
    const criticalWarnings = plan.warnings.filter((w) => w.level === 'error');
    if (criticalWarnings.length > 0) {
      errors.push(`${criticalWarnings.length} critical errors found in migration plan`);
      canProceed = false;
    }

    // Validate operation dependencies
    const dependencyErrors = this.validateOperationDependencies(plan.operations);
    errors.push(...dependencyErrors);
    if (dependencyErrors.length > 0) {
      canProceed = false;
    }

    // Check for conflicting operations
    const conflictErrors = this.checkForConflicts(plan.operations);
    errors.push(...conflictErrors);
    if (conflictErrors.length > 0) {
      canProceed = false;
    }

    // Validate SQL syntax (basic check)
    for (const operation of plan.operations) {
      if (!this.isValidSQL(operation.sql)) {
        errors.push(`Invalid SQL in operation: ${operation.description}`);
        canProceed = false;
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      canProceed,
    };
  }

  /**
   * Generates operations for creating a new table
   */
  private generateCreateTableOperations(
    tableDef: TableDefinition,
    schemaName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];
    const fullTableName = `"${schemaName}"."${tableDef.name}"`;

    // Create the table structure (without foreign keys initially)
    const createTableSQL = this.generateCreateTableSQL(tableDef, schemaName);
    operations.push({
      type: 'CREATE_TABLE',
      sql: createTableSQL,
      isDestructive: false,
      tableName: tableDef.name,
      description: `Create table ${tableDef.name}`,
    });

    // Add indexes (except primary key, which is included in table creation)
    for (const index of tableDef.indexes) {
      const columnList = index.columns.map((col) => `"${col}"`).join(', ');
      const uniqueClause = index.unique ? 'UNIQUE ' : '';
      operations.push({
        type: 'CREATE_INDEX',
        sql: `CREATE ${uniqueClause}INDEX "${index.name}" ON ${fullTableName} (${columnList})`,
        isDestructive: false,
        tableName: tableDef.name,
        description: `Create ${index.unique ? 'unique ' : ''}index ${index.name}`,
      });
    }

    // Add foreign key constraints (after all tables are created)
    for (const fk of tableDef.foreignKeys) {
      const localColumns = fk.columns.map((col) => `"${col}"`).join(', ');
      const referencedColumns = fk.referencedColumns.map((col) => `"${col}"`).join(', ');
      const referencedTable = `"${schemaName}"."${fk.referencedTable}"`;

      let sql =
        `ALTER TABLE ${fullTableName} ADD CONSTRAINT "${fk.name}" ` +
        `FOREIGN KEY (${localColumns}) REFERENCES ${referencedTable} (${referencedColumns})`;

      if (fk.onDelete) {
        sql += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
      }

      operations.push({
        type: 'CREATE_CONSTRAINT',
        sql,
        isDestructive: false,
        tableName: tableDef.name,
        description: `Add foreign key constraint ${fk.name}`,
      });
    }

    // Add check constraints
    for (const cc of tableDef.checkConstraints) {
      operations.push({
        type: 'CREATE_CONSTRAINT',
        sql: `ALTER TABLE ${fullTableName} ADD CONSTRAINT "${cc.name}" CHECK (${cc.expression})`,
        isDestructive: false,
        tableName: tableDef.name,
        description: `Add check constraint ${cc.name}`,
      });
    }

    return operations;
  }

  /**
   * Generates CREATE TABLE SQL from table definition
   */
  private generateCreateTableSQL(tableDef: TableDefinition, schemaName: string): string {
    const columnDefs = tableDef.columns
      .map((col) => {
        let def = `"${col.name}" ${col.type}`;
        // Only add PRIMARY KEY for single column primary keys if no composite primary key exists
        if (col.primaryKey && !tableDef.compositePrimaryKey) def += ' PRIMARY KEY';
        if (col.notNull && !col.primaryKey) def += ' NOT NULL';
        if (col.unique) def += ' UNIQUE';
        if (col.defaultValue) {
          def += ` DEFAULT ${col.defaultValue}`;
        }
        return def;
      })
      .join(',\n    ');

    // Add constraints
    const constraints: string[] = [];

    // Add composite primary key if it exists
    if (tableDef.compositePrimaryKey) {
      constraints.push(
        `CONSTRAINT "${tableDef.compositePrimaryKey.name}" PRIMARY KEY ("${tableDef.compositePrimaryKey.columns.join('", "')}")`
      );
    }

    // Add unique constraints
    const uniqueConstraints = tableDef.indexes
      .filter((idx) => idx.unique)
      .map((idx) => `CONSTRAINT "${idx.name}" UNIQUE ("${idx.columns.join('", "')}")`);
    constraints.push(...uniqueConstraints);

    const allConstraints =
      constraints.length > 0 ? `${columnDefs},\n    ${constraints.join(',\n    ')}` : columnDefs;

    return `CREATE TABLE "${schemaName}"."${tableDef.name}" (\n    ${allConstraints}\n)`;
  }

  /**
   * Analyzes migration plan for potential safety issues
   */
  private analyzePlanSafety(operations: MigrationOperation[]): { warnings: MigrationWarning[] } {
    const warnings: MigrationWarning[] = [];

    for (const operation of operations) {
      if (operation.isDestructive) {
        warnings.push({
          level: 'warning',
          message: `Destructive operation: ${operation.description}`,
          operation,
          recommendation:
            'Consider backing up data before proceeding. This operation may cause data loss.',
        });
      }

      // Warn about operations that might take a long time
      if (this.isLongRunningOperation(operation)) {
        warnings.push({
          level: 'info',
          message: `Long-running operation: ${operation.description}`,
          operation,
          recommendation:
            'This operation may take several minutes on large tables. Consider running during maintenance window.',
        });
      }

      // Warn about operations that might lock tables
      if (this.isLockingOperation(operation)) {
        warnings.push({
          level: 'warning',
          message: `Table-locking operation: ${operation.description}`,
          operation,
          recommendation:
            'This operation will lock the table and may affect application performance.',
        });
      }
    }

    return { warnings };
  }

  /**
   * Orders operations for safe execution
   */
  private orderOperationsForExecution(operations: MigrationOperation[]): MigrationOperation[] {
    // Categorize operations by priority
    const createTables = operations.filter((op) => op.type === 'CREATE_TABLE');
    const dropConstraints = operations.filter((op) => op.type === 'DROP_CONSTRAINT');
    const dropIndexes = operations.filter((op) => op.type === 'DROP_INDEX');
    const alterTables = operations.filter((op) => op.type === 'ALTER_TABLE');
    const createIndexes = operations.filter((op) => op.type === 'CREATE_INDEX');
    const createConstraints = operations.filter((op) => op.type === 'CREATE_CONSTRAINT');

    // Order within each category
    const orderedCreateTables = this.topologicalSortTables(createTables);
    const orderedCreateConstraints = this.orderConstraintCreation(createConstraints);

    return [
      ...orderedCreateTables,
      ...dropConstraints,
      ...dropIndexes,
      ...alterTables,
      ...createIndexes,
      ...orderedCreateConstraints,
    ];
  }

  /**
   * Topologically sorts table creation operations based on dependencies
   */
  private topologicalSortTables(createOps: MigrationOperation[]): MigrationOperation[] {
    // For now, return as-is. In a full implementation, this would analyze
    // foreign key dependencies to determine creation order
    return createOps;
  }

  /**
   * Orders constraint creation to avoid dependency issues
   */
  private orderConstraintCreation(constraintOps: MigrationOperation[]): MigrationOperation[] {
    // Foreign keys should be created after all tables exist
    const foreignKeys = constraintOps.filter((op) => op.sql.includes('FOREIGN KEY'));
    const others = constraintOps.filter((op) => !op.sql.includes('FOREIGN KEY'));

    return [...others, ...foreignKeys];
  }

  /**
   * Determines if the migration requires user confirmation
   */
  private requiresConfirmation(
    operations: MigrationOperation[],
    warnings: MigrationWarning[]
  ): boolean {
    // Require confirmation for destructive operations
    if (operations.some((op) => op.isDestructive)) {
      return true;
    }

    // Require confirmation if there are warning-level or error-level warnings
    if (warnings.some((w) => w.level === 'warning' || w.level === 'error')) {
      return true;
    }

    // Require confirmation for large numbers of operations
    if (operations.length > 10) {
      return true;
    }

    return false;
  }

  /**
   * Estimates migration duration in seconds
   */
  private estimateDuration(operations: MigrationOperation[]): number {
    let totalSeconds = 0;

    for (const operation of operations) {
      switch (operation.type) {
        case 'CREATE_TABLE':
          totalSeconds += 2; // 2 seconds per table
          break;
        case 'ALTER_TABLE':
          if (operation.isDestructive) {
            totalSeconds += 5; // Destructive operations take longer
          } else {
            totalSeconds += 3; // 3 seconds per alter
          }
          break;
        case 'CREATE_INDEX':
          totalSeconds += 10; // Indexes can take time on large tables
          break;
        case 'CREATE_CONSTRAINT':
          if (operation.sql.includes('FOREIGN KEY')) {
            totalSeconds += 5; // FK validation takes time
          } else {
            totalSeconds += 2;
          }
          break;
        default:
          totalSeconds += 1;
      }
    }

    return Math.max(totalSeconds, 1); // At least 1 second
  }

  /**
   * Determines if backup is recommended before migration
   */
  private recommendsBackup(operations: MigrationOperation[]): boolean {
    return operations.some((op) => op.isDestructive);
  }

  /**
   * Checks if an operation is likely to be long-running
   */
  private isLongRunningOperation(operation: MigrationOperation): boolean {
    return (
      operation.type === 'CREATE_INDEX' ||
      (operation.type === 'ALTER_TABLE' && operation.sql.includes('ALTER COLUMN')) ||
      (operation.type === 'CREATE_CONSTRAINT' && operation.sql.includes('FOREIGN KEY'))
    );
  }

  /**
   * Checks if an operation will lock tables
   */
  private isLockingOperation(operation: MigrationOperation): boolean {
    return (
      operation.type === 'ALTER_TABLE' ||
      operation.type === 'CREATE_INDEX' ||
      (operation.type === 'CREATE_CONSTRAINT' && operation.sql.includes('FOREIGN KEY'))
    );
  }

  /**
   * Validates dependencies between operations
   */
  private validateOperationDependencies(operations: MigrationOperation[]): string[] {
    const errors: string[] = [];
    const tableNames = new Set<string>();

    // Track table creation
    for (const operation of operations) {
      if (operation.type === 'CREATE_TABLE') {
        tableNames.add(operation.tableName);
      }
    }

    // Check that foreign key references exist
    for (const operation of operations) {
      if (operation.type === 'CREATE_CONSTRAINT' && operation.sql.includes('FOREIGN KEY')) {
        const match = operation.sql.match(/REFERENCES\s+"[^"]+"\."([^"]+)"/);
        if (match) {
          const referencedTable = match[1];
          if (!tableNames.has(referencedTable)) {
            // Check if it's an alteration to an existing table
            const isAlteringExistingTable = operations.some(
              (op) =>
                op.tableName === operation.tableName &&
                (op.type === 'ALTER_TABLE' || op.type === 'CREATE_CONSTRAINT')
            );

            if (!isAlteringExistingTable) {
              errors.push(
                `Foreign key in ${operation.tableName} references non-existent table: ${referencedTable}`
              );
            }
          }
        }
      }
    }

    return errors;
  }

  /**
   * Checks for conflicting operations
   */
  private checkForConflicts(operations: MigrationOperation[]): string[] {
    const errors: string[] = [];
    const operationsByTable = new Map<string, MigrationOperation[]>();

    // Group operations by table
    for (const operation of operations) {
      if (!operationsByTable.has(operation.tableName)) {
        operationsByTable.set(operation.tableName, []);
      }
      operationsByTable.get(operation.tableName)!.push(operation);
    }

    // Check for conflicts within each table
    for (const [tableName, tableOps] of operationsByTable) {
      const createTable = tableOps.find((op) => op.type === 'CREATE_TABLE');
      const alterTable = tableOps.filter((op) => op.type === 'ALTER_TABLE');

      if (createTable && alterTable.length > 0) {
        errors.push(
          `Conflicting operations on table ${tableName}: both CREATE and ALTER operations found`
        );
      }
    }

    return errors;
  }

  /**
   * Basic SQL syntax validation
   */
  private isValidSQL(sql: string): boolean {
    // Very basic validation - just check for common syntax issues
    const trimmed = sql.trim();

    if (!trimmed) return false;
    if (
      !trimmed.endsWith(';') &&
      !trimmed.toUpperCase().startsWith('CREATE') &&
      !trimmed.toUpperCase().startsWith('ALTER')
    ) {
      // Most SQL commands should end with semicolon, but our generated SQL might not
      // This is just a basic check
    }

    // Check for balanced quotes
    const singleQuotes = (trimmed.match(/'/g) || []).length;
    const doubleQuotes = (trimmed.match(/"/g) || []).length;

    if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0) {
      return false;
    }

    return true;
  }
}
