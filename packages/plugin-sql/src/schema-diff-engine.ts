import { logger } from '@elizaos/core';
import type { DatabaseTable, DatabaseColumn } from './database-introspector';
import type {
  TableDefinition,
  ColumnDefinition,
  IndexDefinition,
  ForeignKeyDefinition,
} from './custom-migrator';

export interface SchemaDiff {
  tablesToCreate: TableDefinition[];
  tablesToDrop: string[];
  tablesToAlter: TableAlterations[];
}

export interface TableAlterations {
  tableName: string;
  columnsToAdd: ColumnDefinition[];
  columnsToDrop: string[];
  columnsToModify: ColumnModification[];
  indexesToAdd: IndexDefinition[];
  indexesToDrop: string[];
  foreignKeysToAdd: ForeignKeyDefinition[];
  foreignKeysToDrop: string[];
  checkConstraintsToAdd: { name: string; expression: string }[];
  checkConstraintsToDrop: string[];
  primaryKeyToAdd?: { name: string; columns: string[] };
  primaryKeyToDrop?: string;
}

export interface ColumnModification {
  columnName: string;
  changes: {
    type?: { from: string; to: string };
    nullable?: { from: boolean; to: boolean };
    default?: { from: string | undefined; to: string | undefined };
    unique?: { from: boolean; to: boolean };
  };
}

/**
 * SchemaDiffEngine compares desired schema (from Drizzle definitions)
 * with current database schema to identify necessary alterations
 */
export class SchemaDiffEngine {
  /**
   * Computes the difference between desired and current schemas
   */
  async computeDiff(
    desired: Map<string, TableDefinition>,
    current: Map<string, DatabaseTable>
  ): Promise<SchemaDiff> {
    logger.debug(
      `[SCHEMA DIFF] Computing diff between ${desired.size} desired and ${current.size} current tables`
    );

    const diff: SchemaDiff = {
      tablesToCreate: [],
      tablesToDrop: [],
      tablesToAlter: [],
    };

    // Find tables to create (in desired but not in current)
    for (const [tableName, tableDef] of desired) {
      if (!current.has(tableName)) {
        diff.tablesToCreate.push(tableDef);
        logger.debug(`[SCHEMA DIFF] Table to create: ${tableName}`);
      }
    }

    // Find tables to drop (in current but not in desired)
    // Note: We're conservative here - we don't automatically drop tables
    // Instead, we log warnings for manual review
    for (const [tableName] of current) {
      if (!desired.has(tableName)) {
        diff.tablesToDrop.push(tableName);
        logger.warn(
          `[SCHEMA DIFF] Table exists in database but not in schema: ${tableName} (manual review required)`
        );
      }
    }

    // Find tables to alter (in both but potentially different)
    for (const [tableName, desiredTable] of desired) {
      const currentTable = current.get(tableName);
      if (currentTable) {
        const alterations = this.computeTableAlterations(desiredTable, currentTable);
        if (this.hasAlterations(alterations)) {
          diff.tablesToAlter.push(alterations);
          logger.debug(`[SCHEMA DIFF] Table to alter: ${tableName}`, {
            columnsToAdd: alterations.columnsToAdd.length,
            columnsToDrop: alterations.columnsToDrop.length,
            columnsToModify: alterations.columnsToModify.length,
            indexesToAdd: alterations.indexesToAdd.length,
            foreignKeysToAdd: alterations.foreignKeysToAdd.length,
          });
        }
      }
    }

    logger.info(
      `[SCHEMA DIFF] Diff summary: ${diff.tablesToCreate.length} to create, ${diff.tablesToDrop.length} to drop, ${diff.tablesToAlter.length} to alter`
    );
    return diff;
  }

  /**
   * Computes alterations needed for a single table
   */
  private computeTableAlterations(
    desired: TableDefinition,
    current: DatabaseTable
  ): TableAlterations {
    const alterations: TableAlterations = {
      tableName: desired.name,
      columnsToAdd: [],
      columnsToDrop: [],
      columnsToModify: [],
      indexesToAdd: [],
      indexesToDrop: [],
      foreignKeysToAdd: [],
      foreignKeysToDrop: [],
      checkConstraintsToAdd: [],
      checkConstraintsToDrop: [],
    };

    // Compare columns
    this.compareColumns(desired, current, alterations);

    // Compare indexes (including unique constraints)
    this.compareIndexes(desired, current, alterations);

    // Compare foreign keys
    this.compareForeignKeys(desired, current, alterations);

    // Compare check constraints
    this.compareCheckConstraints(desired, current, alterations);

    // Compare primary keys
    this.comparePrimaryKeys(desired, current, alterations);

    return alterations;
  }

  /**
   * Compares columns between desired and current table
   */
  private compareColumns(
    desired: TableDefinition,
    current: DatabaseTable,
    alterations: TableAlterations
  ): void {
    const currentColumns = new Map(current.columns.map((col) => [col.name, col]));
    const desiredColumns = new Map(desired.columns.map((col) => [col.name, col]));

    // Find columns to add
    for (const [colName, desiredCol] of desiredColumns) {
      if (!currentColumns.has(colName)) {
        alterations.columnsToAdd.push(desiredCol);
      }
    }

    // Find columns to drop or modify
    for (const [colName, currentCol] of currentColumns) {
      const desiredCol = desiredColumns.get(colName);
      if (!desiredCol) {
        alterations.columnsToDrop.push(colName);
      } else {
        const modification = this.compareColumnDefinitions(currentCol, desiredCol);
        if (modification) {
          alterations.columnsToModify.push(modification);
        }
      }
    }
  }

  /**
   * Compares two column definitions to find differences
   */
  private compareColumnDefinitions(
    current: DatabaseColumn,
    desired: ColumnDefinition
  ): ColumnModification | null {
    const changes: ColumnModification['changes'] = {};
    let hasChanges = false;

    // Compare types
    const currentType = this.normalizeType(current.type);
    const desiredType = this.normalizeType(desired.type);
    if (currentType !== desiredType) {
      changes.type = { from: currentType, to: desiredType };
      hasChanges = true;
    }

    // Compare nullability
    if (current.nullable !== !desired.notNull) {
      changes.nullable = { from: current.nullable, to: !desired.notNull };
      hasChanges = true;
    }

    // Compare default values
    const currentDefault = this.normalizeDefault(current.defaultValue);
    const desiredDefault = this.normalizeDefault(desired.defaultValue);
    if (currentDefault !== desiredDefault) {
      changes.default = { from: currentDefault, to: desiredDefault };
      hasChanges = true;
    }

    // Compare unique constraints - but skip for primary key columns
    const isPrimaryKey = current.isPrimaryKey || desired.primaryKey;
    if (!isPrimaryKey && current.isUnique !== (desired.unique || false)) {
      changes.unique = { from: current.isUnique, to: desired.unique || false };
      hasChanges = true;
    }

    return hasChanges ? { columnName: current.name, changes } : null;
  }

  /**
   * Compares indexes between desired and current table
   */
  private compareIndexes(
    desired: TableDefinition,
    current: DatabaseTable,
    alterations: TableAlterations
  ): void {
    const currentIndexes = new Map(
      current.indexes.filter((idx) => !idx.isPrimary).map((idx) => [idx.name, idx])
    );
    const desiredIndexes = new Map(desired.indexes.map((idx) => [idx.name, idx]));

    // Find indexes to add
    for (const [idxName, desiredIdx] of desiredIndexes) {
      if (!currentIndexes.has(idxName)) {
        alterations.indexesToAdd.push(desiredIdx);
      }
    }

    // Find indexes to drop
    for (const [idxName] of currentIndexes) {
      if (!desiredIndexes.has(idxName)) {
        alterations.indexesToDrop.push(idxName);
      }
    }

    // Note: We don't modify existing indexes - we drop and recreate them
    // This is safer than trying to alter index definitions
  }

  /**
   * Compares foreign keys between desired and current table
   */
  private compareForeignKeys(
    desired: TableDefinition,
    current: DatabaseTable,
    alterations: TableAlterations
  ): void {
    const currentFKs = new Map(current.foreignKeys.map((fk) => [fk.name, fk]));
    const desiredFKs = new Map(desired.foreignKeys.map((fk) => [fk.name, fk]));

    // Find foreign keys to add
    for (const [fkName, desiredFK] of desiredFKs) {
      if (!currentFKs.has(fkName)) {
        alterations.foreignKeysToAdd.push(desiredFK);
      }
    }

    // Find foreign keys to drop
    for (const [fkName] of currentFKs) {
      if (!desiredFKs.has(fkName)) {
        alterations.foreignKeysToDrop.push(fkName);
      }
    }

    // Note: We don't modify existing foreign keys - we drop and recreate them
    // This is safer than trying to alter FK definitions
  }

  /**
   * Compares check constraints between desired and current table
   */
  private compareCheckConstraints(
    desired: TableDefinition,
    current: DatabaseTable,
    alterations: TableAlterations
  ): void {
    const currentConstraints = new Map(current.checkConstraints.map((cc) => [cc.name, cc]));
    const desiredConstraints = new Map(desired.checkConstraints.map((cc) => [cc.name, cc]));

    // Find check constraints to add
    for (const [ccName, desiredCC] of desiredConstraints) {
      if (!currentConstraints.has(ccName)) {
        alterations.checkConstraintsToAdd.push(desiredCC);
      }
    }

    // Find check constraints to drop
    for (const [ccName] of currentConstraints) {
      if (!desiredConstraints.has(ccName)) {
        alterations.checkConstraintsToDrop.push(ccName);
      }
    }
  }

  /**
   * Compares primary keys between desired and current table
   */
  private comparePrimaryKeys(
    desired: TableDefinition,
    current: DatabaseTable,
    alterations: TableAlterations
  ): void {
    const currentPK = current.primaryKey;
    const desiredPK = desired.compositePrimaryKey;

    // Check if we need to add a primary key
    if (desiredPK && !currentPK) {
      alterations.primaryKeyToAdd = desiredPK;
    }
    // Check if we need to drop a primary key
    else if (currentPK && !desiredPK) {
      alterations.primaryKeyToDrop = currentPK.name;
    }
    // Check if we need to modify the primary key
    else if (currentPK && desiredPK) {
      const currentColumns = [...currentPK.columns].sort();
      const desiredColumns = [...desiredPK.columns].sort();

      if (JSON.stringify(currentColumns) !== JSON.stringify(desiredColumns)) {
        // Drop old and add new
        alterations.primaryKeyToDrop = currentPK.name;
        alterations.primaryKeyToAdd = desiredPK;
      }
    }
  }

  /**
   * Normalizes type names for comparison
   */
  private normalizeType(type: string): string {
    return (
      type
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim()
        // Handle common aliases
        .replace('CHARACTER VARYING', 'VARCHAR')
        .replace('CHARACTER', 'CHAR')
        .replace('TIMESTAMP WITHOUT TIME ZONE', 'TIMESTAMP')
        .replace('TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ')
        .replace('DOUBLE PRECISION', 'FLOAT8')
        // Normalize vector types
        .replace(/VECTOR\(\s*(\d+)\s*\)/, 'VECTOR($1)')
        // Handle PGLite specific types
        .replace('USER-DEFINED', 'VECTOR') // PGLite represents vector as USER-DEFINED
        .replace('ARRAY', 'TEXT[]') // Normalize array types
    );
  }

  /**
   * Normalizes default values for comparison
   */
  private normalizeDefault(defaultValue: string | undefined): string | undefined {
    if (!defaultValue) return undefined;

    return (
      defaultValue
        .trim()
        // Remove surrounding quotes for string literals
        .replace(/^'(.*)'$/, '$1')
        // Normalize function calls
        .replace(/NOW\(\)/i, 'now()')
        .replace(/GEN_RANDOM_UUID\(\)/i, 'gen_random_uuid()')
        // Remove PostgreSQL-specific casting
        .replace(/::[\w\\[\\]]+/g, '')
    );
  }

  /**
   * Checks if table alterations contain any actual changes
   */
  private hasAlterations(alterations: TableAlterations): boolean {
    return (
      alterations.columnsToAdd.length > 0 ||
      alterations.columnsToDrop.length > 0 ||
      alterations.columnsToModify.length > 0 ||
      alterations.indexesToAdd.length > 0 ||
      alterations.indexesToDrop.length > 0 ||
      alterations.foreignKeysToAdd.length > 0 ||
      alterations.foreignKeysToDrop.length > 0 ||
      alterations.checkConstraintsToAdd.length > 0 ||
      alterations.checkConstraintsToDrop.length > 0 ||
      alterations.primaryKeyToAdd !== undefined ||
      alterations.primaryKeyToDrop !== undefined
    );
  }

  /**
   * Analyzes the safety of a schema diff and returns warnings
   */
  analyzeRisks(diff: SchemaDiff): string[] {
    const warnings: string[] = [];

    // Warn about table drops
    if (diff.tablesToDrop.length > 0) {
      warnings.push(
        `⚠️  ${diff.tablesToDrop.length} tables exist in database but not in schema. Manual review required: ${diff.tablesToDrop.join(', ')}`
      );
    }

    // Warn about potentially destructive column operations
    for (const alteration of diff.tablesToAlter) {
      if (alteration.columnsToDrop.length > 0) {
        warnings.push(
          `⚠️  Table ${alteration.tableName}: Dropping columns will permanently delete data: ${alteration.columnsToDrop.join(', ')}`
        );
      }

      for (const modification of alteration.columnsToModify) {
        if (modification.changes.type) {
          warnings.push(
            `⚠️  Table ${alteration.tableName}: Changing column ${modification.columnName} type from ${modification.changes.type.from} to ${modification.changes.type.to} may cause data loss`
          );
        }
        if (modification.changes.nullable && !modification.changes.nullable.to) {
          warnings.push(
            `⚠️  Table ${alteration.tableName}: Making column ${modification.columnName} NOT NULL may fail if existing NULL values exist`
          );
        }
      }

      if (alteration.primaryKeyToDrop) {
        warnings.push(
          `⚠️  Table ${alteration.tableName}: Dropping primary key ${alteration.primaryKeyToDrop} may affect referential integrity`
        );
      }
    }

    return warnings;
  }
}
