import type { SchemaSnapshot } from '../types';

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
  };
  foreignKeys: {
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
    },
    foreignKeys: {
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
          const hasChanges =
            prevCol.type !== currCol.type ||
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

      // Find new indexes
      for (const indexName in currIndexes) {
        if (!(indexName in prevIndexes)) {
          diff.indexes.created.push({
            ...currIndexes[indexName],
            table: tableName,
          });
        }
      }

      // Find deleted indexes
      for (const indexName in prevIndexes) {
        if (!(indexName in currIndexes)) {
          diff.indexes.deleted.push({
            name: indexName,
            table: tableName,
          });
        }
      }

      // Compare foreign keys
      const prevFKs = prevTable.foreignKeys || {};
      const currFKs = currTable.foreignKeys || {};

      // Find new foreign keys
      for (const fkName in currFKs) {
        if (!(fkName in prevFKs)) {
          diff.foreignKeys.created.push(currFKs[fkName]);
        }
      }

      // Find deleted foreign keys
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
    diff.foreignKeys.created.length > 0 ||
    diff.foreignKeys.deleted.length > 0
  );
}
