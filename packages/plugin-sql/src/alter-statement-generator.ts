import { logger } from '@elizaos/core';
import type { TableAlterations, ColumnModification } from './schema-diff-engine';
import type { ColumnDefinition, IndexDefinition, ForeignKeyDefinition } from './custom-migrator';

export interface MigrationOperation {
  type:
    | 'CREATE_TABLE'
    | 'ALTER_TABLE'
    | 'DROP_TABLE'
    | 'CREATE_INDEX'
    | 'DROP_INDEX'
    | 'CREATE_CONSTRAINT'
    | 'DROP_CONSTRAINT';
  sql: string;
  isDestructive: boolean;
  affectedRows?: number;
  tableName: string;
  description: string;
}

/**
 * AlterStatementGenerator creates SQL ALTER statements for schema migrations
 * with careful attention to data safety and PostgreSQL compatibility
 */
export class AlterStatementGenerator {
  /**
   * Generates all ALTER statements for a table's modifications
   */
  generateAlterTable(alterations: TableAlterations, schemaName: string): MigrationOperation[] {
    const operations: MigrationOperation[] = [];

    // 1. Drop constraints first (foreign keys, check constraints, primary keys)
    operations.push(...this.generateDropConstraints(alterations, schemaName));

    // 2. Drop columns (destructive operation)
    operations.push(...this.generateDropColumns(alterations, schemaName));

    // 3. Add new columns
    operations.push(...this.generateAddColumns(alterations, schemaName));

    // 4. Modify existing columns
    operations.push(...this.generateModifyColumns(alterations, schemaName));

    // 5. Drop indexes
    operations.push(...this.generateDropIndexes(alterations, schemaName));

    // 6. Add new indexes
    operations.push(...this.generateAddIndexes(alterations, schemaName));

    // 7. Add constraints (foreign keys, check constraints, primary keys)
    operations.push(...this.generateAddConstraints(alterations, schemaName));

    logger.debug(
      `[ALTER GENERATOR] Generated ${operations.length} operations for table ${alterations.tableName}`
    );
    return operations;
  }

  /**
   * Generates operations to drop constraints
   */
  private generateDropConstraints(
    alterations: TableAlterations,
    schemaName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];
    const fullTableName = `"${schemaName}"."${alterations.tableName}"`;

    // Drop primary key
    if (alterations.primaryKeyToDrop) {
      operations.push({
        type: 'DROP_CONSTRAINT',
        sql: `ALTER TABLE ${fullTableName} DROP CONSTRAINT "${alterations.primaryKeyToDrop}"`,
        isDestructive: true,
        tableName: alterations.tableName,
        description: `Drop primary key constraint ${alterations.primaryKeyToDrop}`,
      });
    }

    // Drop foreign keys
    for (const fkName of alterations.foreignKeysToDrop) {
      operations.push({
        type: 'DROP_CONSTRAINT',
        sql: `ALTER TABLE ${fullTableName} DROP CONSTRAINT "${fkName}"`,
        isDestructive: false,
        tableName: alterations.tableName,
        description: `Drop foreign key constraint ${fkName}`,
      });
    }

    // Drop check constraints
    for (const ccName of alterations.checkConstraintsToDrop) {
      operations.push({
        type: 'DROP_CONSTRAINT',
        sql: `ALTER TABLE ${fullTableName} DROP CONSTRAINT "${ccName}"`,
        isDestructive: false,
        tableName: alterations.tableName,
        description: `Drop check constraint ${ccName}`,
      });
    }

    return operations;
  }

  /**
   * Generates operations to drop columns
   */
  private generateDropColumns(
    alterations: TableAlterations,
    schemaName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];
    const fullTableName = `"${schemaName}"."${alterations.tableName}"`;

    for (const columnName of alterations.columnsToDrop) {
      operations.push({
        type: 'ALTER_TABLE',
        sql: `ALTER TABLE ${fullTableName} DROP COLUMN "${columnName}"`,
        isDestructive: true,
        tableName: alterations.tableName,
        description: `Drop column ${columnName} (DATA WILL BE LOST)`,
      });
    }

    return operations;
  }

  /**
   * Generates operations to add columns
   */
  private generateAddColumns(
    alterations: TableAlterations,
    schemaName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];
    const fullTableName = `"${schemaName}"."${alterations.tableName}"`;

    for (const column of alterations.columnsToAdd) {
      const sql = this.generateAddColumnSQL(fullTableName, column);
      operations.push({
        type: 'ALTER_TABLE',
        sql,
        isDestructive: false,
        tableName: alterations.tableName,
        description: `Add column ${column.name}`,
      });
    }

    return operations;
  }

  /**
   * Generates SQL for adding a single column
   */
  private generateAddColumnSQL(fullTableName: string, column: ColumnDefinition): string {
    let sql = `ALTER TABLE ${fullTableName} ADD COLUMN "${column.name}" ${column.type}`;

    // Add DEFAULT before NOT NULL if both are present
    if (column.defaultValue) {
      sql += ` DEFAULT ${this.formatDefaultValue(column.defaultValue)}`;
    }

    if (column.notNull) {
      // For existing tables with data, we can't add NOT NULL columns without defaults
      if (!column.defaultValue) {
        throw new Error(
          `Cannot add NOT NULL column "${column.name}" without a default value to table with existing data`
        );
      }
      sql += ' NOT NULL';
    }

    if (column.unique) {
      sql += ' UNIQUE';
    }

    return sql;
  }

  /**
   * Generates operations to modify existing columns
   */
  private generateModifyColumns(
    alterations: TableAlterations,
    schemaName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];
    const fullTableName = `"${schemaName}"."${alterations.tableName}"`;

    for (const modification of alterations.columnsToModify) {
      operations.push(
        ...this.generateModifyColumnSQL(fullTableName, modification, alterations.tableName)
      );
    }

    return operations;
  }

  /**
   * Generates SQL statements for modifying a single column
   */
  private generateModifyColumnSQL(
    fullTableName: string,
    modification: ColumnModification,
    tableName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];
    const columnName = modification.columnName;

    // Type change (potentially destructive)
    if (modification.changes.type) {
      const { from, to } = modification.changes.type;
      const isRisky = this.isTypeChangeRisky(from, to);

      let sql = `ALTER TABLE ${fullTableName} ALTER COLUMN "${columnName}" TYPE ${to}`;

      // Add USING clause for potentially problematic type conversions
      if (isRisky) {
        sql += ` USING "${columnName}"::${to}`;
      }

      operations.push({
        type: 'ALTER_TABLE',
        sql,
        isDestructive: isRisky,
        tableName,
        description: `Change column ${columnName} type from ${from} to ${to}${isRisky ? ' (may cause data loss)' : ''}`,
      });
    }

    // Nullability change
    if (modification.changes.nullable !== undefined) {
      const { to } = modification.changes.nullable;
      const sql = to
        ? `ALTER TABLE ${fullTableName} ALTER COLUMN "${columnName}" DROP NOT NULL`
        : `ALTER TABLE ${fullTableName} ALTER COLUMN "${columnName}" SET NOT NULL`;

      operations.push({
        type: 'ALTER_TABLE',
        sql,
        isDestructive: !to, // Setting NOT NULL can fail if nulls exist
        tableName,
        description: `${to ? 'Allow' : 'Disallow'} NULL values in column ${columnName}`,
      });
    }

    // Default value change
    if (modification.changes.default !== undefined) {
      const { to } = modification.changes.default;
      const sql = to
        ? `ALTER TABLE ${fullTableName} ALTER COLUMN "${columnName}" SET DEFAULT ${this.formatDefaultValue(to)}`
        : `ALTER TABLE ${fullTableName} ALTER COLUMN "${columnName}" DROP DEFAULT`;

      operations.push({
        type: 'ALTER_TABLE',
        sql,
        isDestructive: false,
        tableName,
        description: `${to ? `Set default value for` : `Remove default value from`} column ${columnName}`,
      });
    }

    // Unique constraint change
    if (modification.changes.unique !== undefined) {
      const { to } = modification.changes.unique;
      if (to) {
        // Add unique constraint
        const constraintName = `${tableName}_${columnName}_unique`;
        operations.push({
          type: 'CREATE_CONSTRAINT',
          sql: `ALTER TABLE ${fullTableName} ADD CONSTRAINT "${constraintName}" UNIQUE ("${columnName}")`,
          isDestructive: false,
          tableName,
          description: `Add unique constraint to column ${columnName}`,
        });
      } else {
        // This would require knowing the constraint name, which is complex
        // For now, we'll log a warning that this needs manual intervention
        logger.warn(
          `[ALTER GENERATOR] Removing unique constraint from ${columnName} requires manual intervention (constraint name unknown)`
        );
      }
    }

    return operations;
  }

  /**
   * Generates operations to drop indexes
   */
  private generateDropIndexes(
    alterations: TableAlterations,
    schemaName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];

    for (const indexName of alterations.indexesToDrop) {
      operations.push({
        type: 'DROP_INDEX',
        sql: `DROP INDEX IF EXISTS "${schemaName}"."${indexName}"`,
        isDestructive: false,
        tableName: alterations.tableName,
        description: `Drop index ${indexName}`,
      });
    }

    return operations;
  }

  /**
   * Generates operations to add indexes
   */
  private generateAddIndexes(
    alterations: TableAlterations,
    schemaName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];
    const fullTableName = `"${schemaName}"."${alterations.tableName}"`;

    for (const index of alterations.indexesToAdd) {
      const sql = this.generateCreateIndexSQL(index, fullTableName, schemaName);
      operations.push({
        type: 'CREATE_INDEX',
        sql,
        isDestructive: false,
        tableName: alterations.tableName,
        description: `Create ${index.unique ? 'unique ' : ''}index ${index.name}`,
      });
    }

    return operations;
  }

  /**
   * Generates SQL for creating an index
   */
  private generateCreateIndexSQL(
    index: IndexDefinition,
    fullTableName: string,
    _schemaName: string
  ): string {
    const uniqueClause = index.unique ? 'UNIQUE ' : '';
    const columnList = index.columns.map((col) => `"${col}"`).join(', ');
    return `CREATE ${uniqueClause}INDEX "${index.name}" ON ${fullTableName} (${columnList})`;
  }

  /**
   * Generates operations to add constraints
   */
  private generateAddConstraints(
    alterations: TableAlterations,
    schemaName: string
  ): MigrationOperation[] {
    const operations: MigrationOperation[] = [];
    const fullTableName = `"${schemaName}"."${alterations.tableName}"`;

    // Add primary key
    if (alterations.primaryKeyToAdd) {
      const pk = alterations.primaryKeyToAdd;
      const columnList = pk.columns.map((col) => `"${col}"`).join(', ');
      operations.push({
        type: 'CREATE_CONSTRAINT',
        sql: `ALTER TABLE ${fullTableName} ADD CONSTRAINT "${pk.name}" PRIMARY KEY (${columnList})`,
        isDestructive: false,
        tableName: alterations.tableName,
        description: `Add primary key constraint ${pk.name}`,
      });
    }

    // Add foreign keys
    for (const fk of alterations.foreignKeysToAdd) {
      const sql = this.generateAddForeignKeySQL(fullTableName, fk, schemaName);
      operations.push({
        type: 'CREATE_CONSTRAINT',
        sql,
        isDestructive: false,
        tableName: alterations.tableName,
        description: `Add foreign key constraint ${fk.name}`,
      });
    }

    // Add check constraints
    for (const cc of alterations.checkConstraintsToAdd) {
      operations.push({
        type: 'CREATE_CONSTRAINT',
        sql: `ALTER TABLE ${fullTableName} ADD CONSTRAINT "${cc.name}" CHECK (${cc.expression})`,
        isDestructive: false,
        tableName: alterations.tableName,
        description: `Add check constraint ${cc.name}`,
      });
    }

    return operations;
  }

  /**
   * Generates SQL for adding a foreign key constraint
   */
  private generateAddForeignKeySQL(
    fullTableName: string,
    fk: ForeignKeyDefinition,
    schemaName: string
  ): string {
    const localColumns = fk.columns.map((col) => `"${col}"`).join(', ');
    const referencedColumns = fk.referencedColumns.map((col) => `"${col}"`).join(', ');
    const referencedTable = `"${schemaName}"."${fk.referencedTable}"`;

    let sql =
      `ALTER TABLE ${fullTableName} ADD CONSTRAINT "${fk.name}" ` +
      `FOREIGN KEY (${localColumns}) REFERENCES ${referencedTable} (${referencedColumns})`;

    if (fk.onDelete) {
      sql += ` ON DELETE ${fk.onDelete.toUpperCase()}`;
    }

    return sql;
  }

  /**
   * Formats default values for SQL
   */
  private formatDefaultValue(defaultValue: string): string {
    // Handle function calls
    if (defaultValue === 'now()' || defaultValue.toLowerCase().includes('now()')) {
      return 'now()';
    }
    if (
      defaultValue === 'gen_random_uuid()' ||
      defaultValue.toLowerCase().includes('gen_random_uuid')
    ) {
      return 'gen_random_uuid()';
    }

    // Handle boolean values
    if (defaultValue === 'true' || defaultValue === 'false') {
      return defaultValue;
    }

    // Handle numbers
    if (!isNaN(Number(defaultValue))) {
      return defaultValue;
    }

    // Handle string literals (already quoted)
    if (defaultValue.startsWith("'") && defaultValue.endsWith("'")) {
      return defaultValue;
    }

    // Handle JSON/JSONB expressions
    if (defaultValue.includes('::jsonb') || defaultValue.includes('::json')) {
      return defaultValue;
    }

    // Handle JSON objects
    if (defaultValue === "'{}'") {
      return "'{}'";
    }

    // Handle SQL expressions that start with parenthesis or contain ::
    if (defaultValue.startsWith('(') || defaultValue.includes('::')) {
      return defaultValue;
    }

    // Default case - quote string literals
    return `'${defaultValue}'`;
  }

  /**
   * Determines if a type change is risky and might cause data loss
   */
  private isTypeChangeRisky(fromType: string, toType: string): boolean {
    const from = fromType.toUpperCase();
    const to = toType.toUpperCase();

    // Safe conversions (non-exhaustive list)
    const safeConversions = [
      ['VARCHAR', 'TEXT'],
      ['CHAR', 'VARCHAR'],
      ['CHAR', 'TEXT'],
      ['INTEGER', 'BIGINT'],
      ['TIMESTAMP', 'TIMESTAMPTZ'],
    ];

    for (const [safeFrom, safeTo] of safeConversions) {
      if (from.includes(safeFrom) && to.includes(safeTo)) {
        return false;
      }
    }

    // Length reductions are risky
    const fromVarcharMatch = from.match(/VARCHAR\((\d+)\)/);
    const toVarcharMatch = to.match(/VARCHAR\((\d+)\)/);
    if (fromVarcharMatch && toVarcharMatch) {
      const fromLength = parseInt(fromVarcharMatch[1]);
      const toLength = parseInt(toVarcharMatch[1]);
      return toLength < fromLength;
    }

    // Different type families are risky
    const typeFamily = (type: string): string => {
      if (type.includes('VARCHAR') || type.includes('TEXT') || type.includes('CHAR')) return 'text';
      if (type.includes('INTEGER') || type.includes('BIGINT') || type.includes('SERIAL'))
        return 'integer';
      if (type.includes('TIMESTAMP') || type.includes('DATE') || type.includes('TIME'))
        return 'datetime';
      if (type.includes('BOOLEAN')) return 'boolean';
      if (type.includes('JSON')) return 'json';
      if (type.includes('UUID')) return 'uuid';
      if (type.includes('VECTOR')) return 'vector';
      return 'other';
    };

    return typeFamily(from) !== typeFamily(to);
  }
}
