import type { SchemaSnapshot } from '../types';

/**
 * Normalize SQL types for comparison
 * Handles equivalent type variations between introspected DB and schema definitions
 */
function normalizeType(type: string | undefined): string {
  if (!type) return '';

  const normalized = type.toLowerCase().trim();

  // Handle timestamp variations
  if (normalized === 'timestamp without time zone' || normalized === 'timestamp with time zone') {
    return 'timestamp';
  }

  // Handle serial vs integer with identity
  // serial is essentially integer with auto-increment
  if (normalized === 'serial') {
    return 'integer';
  }
  if (normalized === 'bigserial') {
    return 'bigint';
  }
  if (normalized === 'smallserial') {
    return 'smallint';
  }

  // Handle numeric/decimal equivalence
  if (normalized.startsWith('numeric') || normalized.startsWith('decimal')) {
    // Extract precision and scale if present
    const match = normalized.match(/\((\d+)(?:,\s*(\d+))?\)/);
    if (match) {
      return `numeric(${match[1]}${match[2] ? `,${match[2]}` : ''})`;
    }
    return 'numeric';
  }

  // Handle varchar/character varying
  if (normalized.startsWith('character varying')) {
    return normalized.replace('character varying', 'varchar');
  }

  // Handle text array variations
  if (normalized === 'text[]' || normalized === '_text') {
    return 'text[]';
  }

  return normalized;
}

/**
 * Helper function to compare two index definitions
 * Returns true if indexes are different and need to be recreated
 */
function isIndexChanged(prevIndex: any, currIndex: any): boolean {
  // Compare basic properties
  if (prevIndex.isUnique !== currIndex.isUnique) return true;
  if (prevIndex.method !== currIndex.method) return true;
  if (prevIndex.where !== currIndex.where) return true;
  if (prevIndex.concurrently !== currIndex.concurrently) return true;

  // Compare columns array - must be same columns in same order
  const prevColumns = prevIndex.columns || [];
  const currColumns = currIndex.columns || [];

  if (prevColumns.length !== currColumns.length) return true;

  for (let i = 0; i < prevColumns.length; i++) {
    const prevCol = prevColumns[i];
    const currCol = currColumns[i];

    // Handle both string columns and expression columns
    if (typeof prevCol === 'string' && typeof currCol === 'string') {
      if (prevCol !== currCol) return true;
    } else if (typeof prevCol === 'object' && typeof currCol === 'object') {
      // Compare expression columns
      if (prevCol.expression !== currCol.expression) return true;
      if (prevCol.isExpression !== currCol.isExpression) return true;
      if (prevCol.asc !== currCol.asc) return true;
      if (prevCol.nulls !== currCol.nulls) return true;
    } else {
      // Type mismatch (one is string, other is object)
      return true;
    }
  }

  return false;
}

export interface SchemaDiff {
  tables: {
    created: string[];
    deleted: string[];
    modified: Array<{
      name: string;
      changes: any;
    }>;
  };
  columns: {
    added: Array<{
      table: string;
      column: string;
      definition: any;
    }>;
    deleted: Array<{
      table: string;
      column: string;
    }>;
    modified: Array<{
      table: string;
      column: string;
      changes: any;
    }>;
  };
  indexes: {
    created: any[];
    deleted: any[];
    altered: Array<{
      // Indexes with same name but different definition
      old: any;
      new: any;
    }>;
  };
  foreignKeys: {
    created: any[];
    deleted: any[];
    altered: Array<{
      // FKs with modified CASCADE behavior
      old: any;
      new: any;
    }>;
  };
  uniqueConstraints: {
    created: any[];
    deleted: any[];
  };
  checkConstraints: {
    created: any[];
    deleted: any[];
  };
}

/**
 * Calculate the difference between two snapshots
 */
export async function calculateDiff(
  previousSnapshot: SchemaSnapshot | null,
  currentSnapshot: SchemaSnapshot
): Promise<SchemaDiff> {
  const diff: SchemaDiff = {
    tables: {
      created: [],
      deleted: [],
      modified: [],
    },
    columns: {
      added: [],
      deleted: [],
      modified: [],
    },
    indexes: {
      created: [],
      deleted: [],
      altered: [],
    },
    foreignKeys: {
      created: [],
      deleted: [],
      altered: [],
    },
    uniqueConstraints: {
      created: [],
      deleted: [],
    },
    checkConstraints: {
      created: [],
      deleted: [],
    },
  };

  // If no previous snapshot, all tables are new
  if (!previousSnapshot) {
    diff.tables.created = Object.keys(currentSnapshot.tables);

    // Also track indexes and foreign keys from new tables
    for (const tableName in currentSnapshot.tables) {
      const table = currentSnapshot.tables[tableName];

      // Add indexes
      if (table.indexes) {
        for (const indexName in table.indexes) {
          diff.indexes.created.push({
            ...table.indexes[indexName],
            table: tableName,
          });
        }
      }

      // Add foreign keys
      if (table.foreignKeys) {
        for (const fkName in table.foreignKeys) {
          diff.foreignKeys.created.push(table.foreignKeys[fkName]);
        }
      }
    }

    return diff;
  }

  const prevTables = previousSnapshot.tables || {};
  const currTables = currentSnapshot.tables || {};

  // Find created tables
  for (const tableName in currTables) {
    if (!(tableName in prevTables)) {
      diff.tables.created.push(tableName);

      const table = currTables[tableName];

      // Add indexes for new table
      if (table.indexes) {
        for (const indexName in table.indexes) {
          diff.indexes.created.push({
            ...table.indexes[indexName],
            table: tableName,
          });
        }
      }

      // Add unique constraints for new table
      if (table.uniqueConstraints) {
        for (const uqName in table.uniqueConstraints) {
          diff.uniqueConstraints.created.push({
            ...table.uniqueConstraints[uqName],
            table: tableName,
          });
        }
      }

      // Add check constraints for new table
      if (table.checkConstraints) {
        for (const checkName in table.checkConstraints) {
          diff.checkConstraints.created.push({
            ...table.checkConstraints[checkName],
            table: tableName,
          });
        }
      }

      // Add foreign keys for new table
      if (table.foreignKeys) {
        for (const fkName in table.foreignKeys) {
          diff.foreignKeys.created.push(table.foreignKeys[fkName]);
        }
      }
    }
  }

  // Find deleted tables
  for (const tableName in prevTables) {
    if (!(tableName in currTables)) {
      diff.tables.deleted.push(tableName);
    }
  }

  // Find modified tables (check columns, indexes, foreign keys)
  for (const tableName in currTables) {
    if (tableName in prevTables) {
      const prevTable = prevTables[tableName];
      const currTable = currTables[tableName];

      // Early check: if the table schemas are identical, skip it entirely
      // This prevents false positives when other tables are modified
      const prevTableJson = JSON.stringify({
        columns: prevTable.columns || {},
        indexes: prevTable.indexes || {},
        foreignKeys: prevTable.foreignKeys || {},
        uniqueConstraints: prevTable.uniqueConstraints || {},
        checkConstraints: prevTable.checkConstraints || {},
      });

      const currTableJson = JSON.stringify({
        columns: currTable.columns || {},
        indexes: currTable.indexes || {},
        foreignKeys: currTable.foreignKeys || {},
        uniqueConstraints: currTable.uniqueConstraints || {},
        checkConstraints: currTable.checkConstraints || {},
      });

      // If tables are identical, skip all processing for this table
      if (prevTableJson === currTableJson) {
        continue;
      }

      // Compare columns
      const prevColumns = prevTable.columns || {};
      const currColumns = currTable.columns || {};

      // Find added columns
      for (const colName in currColumns) {
        if (!(colName in prevColumns)) {
          diff.columns.added.push({
            table: tableName,
            column: colName,
            definition: currColumns[colName],
          });
        }
      }

      // Find deleted columns
      for (const colName in prevColumns) {
        if (!(colName in currColumns)) {
          diff.columns.deleted.push({
            table: tableName,
            column: colName,
          });
        }
      }

      // Find modified columns
      for (const colName in currColumns) {
        if (colName in prevColumns) {
          const prevCol = prevColumns[colName];
          const currCol = currColumns[colName];

          // Check for changes in column properties
          // Use normalized type comparison
          const typeChanged = normalizeType(prevCol.type) !== normalizeType(currCol.type);
          const hasChanges =
            typeChanged ||
            prevCol.notNull !== currCol.notNull ||
            prevCol.default !== currCol.default ||
            prevCol.primaryKey !== currCol.primaryKey;

          if (hasChanges) {
            diff.columns.modified.push({
              table: tableName,
              column: colName,
              changes: {
                from: prevCol,
                to: currCol,
              },
            });
          }
        }
      }

      // Compare indexes
      const prevIndexes = prevTable.indexes || {};
      const currIndexes = currTable.indexes || {};

      // Find new, deleted, and altered indexes
      for (const indexName in currIndexes) {
        if (!(indexName in prevIndexes)) {
          // New index
          diff.indexes.created.push({
            ...currIndexes[indexName],
            table: tableName,
          });
        } else {
          // Check if index definition changed
          const prevIndex = prevIndexes[indexName];
          const currIndex = currIndexes[indexName];

          // Deep comparison of index properties
          const indexChanged = isIndexChanged(prevIndex, currIndex);

          if (indexChanged) {
            // Index definition changed - need to drop and recreate
            diff.indexes.altered.push({
              old: {
                ...prevIndex,
                table: tableName,
                name: indexName,
              },
              new: {
                ...currIndex,
                table: tableName,
                name: indexName,
              },
            });
          }
        }
      }

      // Find deleted indexes (not altered)
      for (const indexName in prevIndexes) {
        if (!(indexName in currIndexes)) {
          diff.indexes.deleted.push({
            name: indexName,
            table: tableName,
          });
        }
      }

      // Compare unique constraints
      const prevUniqueConstraints = prevTable.uniqueConstraints || {};
      const currUniqueConstraints = currTable.uniqueConstraints || {};

      // Find new unique constraints
      for (const uqName in currUniqueConstraints) {
        if (!(uqName in prevUniqueConstraints)) {
          diff.uniqueConstraints.created.push({
            ...currUniqueConstraints[uqName],
            table: tableName,
          });
        }
      }

      // Find deleted unique constraints
      for (const uqName in prevUniqueConstraints) {
        if (!(uqName in currUniqueConstraints)) {
          diff.uniqueConstraints.deleted.push({
            name: uqName,
            table: tableName,
          });
        }
      }

      // Compare check constraints
      const prevCheckConstraints = prevTable.checkConstraints || {};
      const currCheckConstraints = currTable.checkConstraints || {};

      // Find new check constraints
      for (const checkName in currCheckConstraints) {
        if (!(checkName in prevCheckConstraints)) {
          diff.checkConstraints.created.push({
            ...currCheckConstraints[checkName],
            table: tableName,
          });
        }
      }

      // Find deleted check constraints
      for (const checkName in prevCheckConstraints) {
        if (!(checkName in currCheckConstraints)) {
          diff.checkConstraints.deleted.push({
            name: checkName,
            table: tableName,
          });
        }
      }

      // Compare foreign keys
      const prevFKs = prevTable.foreignKeys || {};
      const currFKs = currTable.foreignKeys || {};

      // Find new, deleted, and altered foreign keys
      for (const fkName in currFKs) {
        if (!(fkName in prevFKs)) {
          // New FK
          diff.foreignKeys.created.push(currFKs[fkName]);
        } else {
          // Check if FK definition changed (CASCADE behavior, etc.)
          const prevFK = prevFKs[fkName];
          const currFK = currFKs[fkName];

          // Compare FK properties
          const prevOnDelete = prevFK.onDelete || 'no action';
          const currOnDelete = currFK.onDelete || 'no action';
          const prevOnUpdate = prevFK.onUpdate || 'no action';
          const currOnUpdate = currFK.onUpdate || 'no action';

          if (prevOnDelete !== currOnDelete || prevOnUpdate !== currOnUpdate) {
            // FK CASCADE behavior changed - need to drop and recreate
            diff.foreignKeys.altered.push({
              old: prevFK,
              new: currFK,
            });
          }
        }
      }

      // Find deleted foreign keys (not altered)
      for (const fkName in prevFKs) {
        if (!(fkName in currFKs)) {
          diff.foreignKeys.deleted.push({
            name: fkName,
            tableFrom: tableName,
          });
        }
      }
    }
  }

  return diff;
}

/**
 * Check if a diff has any changes
 */
export function hasDiffChanges(diff: SchemaDiff): boolean {
  return (
    diff.tables.created.length > 0 ||
    diff.tables.deleted.length > 0 ||
    diff.tables.modified.length > 0 ||
    diff.columns.added.length > 0 ||
    diff.columns.deleted.length > 0 ||
    diff.columns.modified.length > 0 ||
    diff.indexes.created.length > 0 ||
    diff.indexes.deleted.length > 0 ||
    diff.indexes.altered.length > 0 ||
    diff.foreignKeys.created.length > 0 ||
    diff.foreignKeys.deleted.length > 0 ||
    diff.foreignKeys.altered.length > 0 ||
    diff.uniqueConstraints.created.length > 0 ||
    diff.uniqueConstraints.deleted.length > 0 ||
    diff.checkConstraints.created.length > 0 ||
    diff.checkConstraints.deleted.length > 0
  );
}
