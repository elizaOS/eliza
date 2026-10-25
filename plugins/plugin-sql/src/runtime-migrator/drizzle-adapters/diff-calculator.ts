/**
 * Diffs two `SchemaSnapshot`s (previous vs. current) into a structured
 * `SchemaDiff` describing every created/deleted/modified table, column,
 * index, foreign key, and constraint. Feeds the SQL generator, which turns
 * the diff into the actual migration statements. Type comparison is
 * normalized (e.g. `serial` vs `integer`, `timestamp with/without time zone`)
 * so equivalent Postgres type spellings don't register as spurious changes.
 */
import type {
  IndexColumn,
  SchemaCheckConstraint,
  SchemaColumn,
  SchemaForeignKey,
  SchemaIndex,
  SchemaSnapshot,
  SchemaUniqueConstraint,
} from "../types";

/**
 * Normalize SQL types for comparison
 * Handles equivalent type variations between introspected DB and schema definitions
 */
function normalizeType(type: string | undefined): string {
  if (!type) return "";

  const normalized = type.toLowerCase().trim();

  // Handle timestamp variations
  if (normalized === "timestamp without time zone" || normalized === "timestamp with time zone") {
    return "timestamp";
  }

  // Handle serial vs integer with identity
  // serial is essentially integer with auto-increment
  if (normalized === "serial") {
    return "integer";
  }
  if (normalized === "bigserial") {
    return "bigint";
  }
  if (normalized === "smallserial") {
    return "smallint";
  }

  // Handle numeric/decimal equivalence
  if (normalized.startsWith("numeric") || normalized.startsWith("decimal")) {
    // Extract precision and scale if present
    const match = normalized.match(/\((\d+)(?:,\s*(\d+))?\)/);
    if (match) {
      return `numeric(${match[1]}${match[2] ? `,${match[2]}` : ""})`;
    }
    return "numeric";
  }

  // Handle varchar/character varying
  if (normalized.startsWith("character varying")) {
    return normalized.replace("character varying", "varchar");
  }

  // Handle text array variations
  if (normalized === "text[]" || normalized === "_text") {
    return "text[]";
  }

  return normalized;
}

/**
 * Helper function to compare two index definitions
 * Returns true if indexes are different and need to be recreated
 */
function isIndexChanged(prevIndex: SchemaIndex, currIndex: SchemaIndex): boolean {
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
    const prevCol = prevColumns[i] as string | IndexColumn;
    const currCol = currColumns[i] as string | IndexColumn;

    // Handle both string columns and expression columns
    if (typeof prevCol === "string" && typeof currCol === "string") {
      if (prevCol !== currCol) return true;
    } else if (typeof prevCol === "object" && typeof currCol === "object") {
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

// Column changes interface
export interface ColumnChanges {
  typeChanged?: boolean;
  prevType?: string;
  newType?: string;
  nullabilityChanged?: boolean;
  wasNullable?: boolean;
  isNullable?: boolean;
  defaultChanged?: boolean;
  prevDefault?: string | number | boolean;
  newDefault?: string | number | boolean;
  from?: SchemaColumn;
  to?: SchemaColumn;
}

// Table changes interface
export interface TableChanges {
  columnsAdded: string[];
  columnsDeleted: string[];
  columnsModified: string[];
}

export interface SchemaDiff {
  tables: {
    created: string[];
    deleted: string[];
    modified: Array<{
      name: string;
      changes: TableChanges;
    }>;
  };
  columns: {
    added: Array<{
      table: string;
      column: string;
      definition: SchemaColumn;
    }>;
    deleted: Array<{
      table: string;
      column: string;
    }>;
    modified: Array<{
      table: string;
      column: string;
      changes: ColumnChanges;
    }>;
  };
  indexes: {
    created: SchemaIndex[];
    deleted: SchemaIndex[];
    altered: Array<{
      // Indexes with same name but different definition
      old: SchemaIndex;
      new: SchemaIndex;
    }>;
  };
  foreignKeys: {
    created: SchemaForeignKey[];
    deleted: SchemaForeignKey[];
    altered: Array<{
      // FKs with modified CASCADE behavior
      old: SchemaForeignKey;
      new: SchemaForeignKey;
    }>;
  };
  uniqueConstraints: {
    created: SchemaUniqueConstraint[];
    deleted: SchemaUniqueConstraint[];
  };
  checkConstraints: {
    created: SchemaCheckConstraint[];
    deleted: SchemaCheckConstraint[];
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

  // If no previous snapshot, all tables (and their indexes/foreign keys) are new.
  if (!previousSnapshot) {
    diff.tables.created = Object.keys(currentSnapshot.tables);

    for (const tableName in currentSnapshot.tables) {
      const table = currentSnapshot.tables[tableName];

      if (table.indexes) {
        for (const indexName in table.indexes) {
          diff.indexes.created.push({
            ...table.indexes[indexName],
            table: tableName,
          } as SchemaIndex & { table: string });
        }
      }

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

  for (const tableName in currTables) {
    if (!(tableName in prevTables)) {
      diff.tables.created.push(tableName);

      const table = currTables[tableName];

      if (table.indexes) {
        for (const indexName in table.indexes) {
          diff.indexes.created.push({
            ...table.indexes[indexName],
            table: tableName,
          } as SchemaIndex & { table: string });
        }
      }

      if (table.uniqueConstraints) {
        for (const uqName in table.uniqueConstraints) {
          diff.uniqueConstraints.created.push({
            ...table.uniqueConstraints[uqName],
            table: tableName,
          } as SchemaUniqueConstraint & { table: string });
        }
      }

      if (table.checkConstraints) {
        for (const checkName in table.checkConstraints) {
          diff.checkConstraints.created.push({
            ...table.checkConstraints[checkName],
            table: tableName,
          } as SchemaCheckConstraint & { table: string });
        }
      }

      if (table.foreignKeys) {
        for (const fkName in table.foreignKeys) {
          diff.foreignKeys.created.push(table.foreignKeys[fkName]);
        }
      }
    }
  }

  for (const tableName in prevTables) {
    if (!(tableName in currTables)) {
      diff.tables.deleted.push(tableName);
    }
  }

  for (const tableName in currTables) {
    if (tableName in prevTables) {
      const prevTable = prevTables[tableName];
      const currTable = currTables[tableName];

      // Skip the table entirely if its schema is unchanged, so an unrelated
      // in-place edit elsewhere in the JSON doesn't register a false positive.
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

      if (prevTableJson === currTableJson) {
        continue;
      }

      const prevColumns = prevTable.columns || {};
      const currColumns = currTable.columns || {};

      for (const colName in currColumns) {
        if (!(colName in prevColumns)) {
          diff.columns.added.push({
            table: tableName,
            column: colName,
            definition: currColumns[colName],
          });
        }
      }

      for (const colName in prevColumns) {
        if (!(colName in currColumns)) {
          diff.columns.deleted.push({
            table: tableName,
            column: colName,
          });
        }
      }

      for (const colName in currColumns) {
        if (colName in prevColumns) {
          const prevCol = prevColumns[colName];
          const currCol = currColumns[colName];

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

      const prevIndexes = prevTable.indexes || {};
      const currIndexes = currTable.indexes || {};

      for (const indexName in currIndexes) {
        if (!(indexName in prevIndexes)) {
          diff.indexes.created.push({
            ...currIndexes[indexName],
            table: tableName,
          } as SchemaIndex & { table: string });
        } else {
          const prevIndex = prevIndexes[indexName];
          const currIndex = currIndexes[indexName];

          const indexChanged = isIndexChanged(prevIndex, currIndex);

          if (indexChanged) {
            // Same name, different definition: drop and recreate rather than ALTER.
            diff.indexes.altered.push({
              old: {
                ...prevIndex,
                table: tableName,
                name: indexName,
              } as SchemaIndex & { table: string },
              new: {
                ...currIndex,
                table: tableName,
                name: indexName,
              } as SchemaIndex & { table: string },
            });
          }
        }
      }

      for (const indexName in prevIndexes) {
        if (!(indexName in currIndexes)) {
          diff.indexes.deleted.push({
            ...prevIndexes[indexName],
            table: tableName,
          } as SchemaIndex & { table: string });
        }
      }

      const prevUniqueConstraints = prevTable.uniqueConstraints || {};
      const currUniqueConstraints = currTable.uniqueConstraints || {};

      for (const uqName in currUniqueConstraints) {
        if (!(uqName in prevUniqueConstraints)) {
          diff.uniqueConstraints.created.push({
            ...currUniqueConstraints[uqName],
            table: tableName,
          } as SchemaUniqueConstraint & { table: string });
        }
      }

      for (const uqName in prevUniqueConstraints) {
        if (!(uqName in currUniqueConstraints)) {
          diff.uniqueConstraints.deleted.push({
            ...prevUniqueConstraints[uqName],
            table: tableName,
          } as SchemaUniqueConstraint & { table: string });
        }
      }

      const prevCheckConstraints = prevTable.checkConstraints || {};
      const currCheckConstraints = currTable.checkConstraints || {};

      for (const checkName in currCheckConstraints) {
        if (!(checkName in prevCheckConstraints)) {
          diff.checkConstraints.created.push({
            ...currCheckConstraints[checkName],
            table: tableName,
          } as SchemaCheckConstraint & { table: string });
        }
      }

      for (const checkName in prevCheckConstraints) {
        if (!(checkName in currCheckConstraints)) {
          diff.checkConstraints.deleted.push({
            ...prevCheckConstraints[checkName],
            table: tableName,
          } as SchemaCheckConstraint & { table: string });
        }
      }

      const prevFKs = prevTable.foreignKeys || {};
      const currFKs = currTable.foreignKeys || {};

      for (const fkName in currFKs) {
        if (!(fkName in prevFKs)) {
          diff.foreignKeys.created.push(currFKs[fkName]);
        } else {
          const prevFK = prevFKs[fkName];
          const currFK = currFKs[fkName];

          const prevOnDelete = prevFK.onDelete || "no action";
          const currOnDelete = currFK.onDelete || "no action";
          const prevOnUpdate = prevFK.onUpdate || "no action";
          const currOnUpdate = currFK.onUpdate || "no action";

          if (prevOnDelete !== currOnDelete || prevOnUpdate !== currOnUpdate) {
            // CASCADE behavior changed: drop and recreate rather than ALTER.
            diff.foreignKeys.altered.push({
              old: prevFK,
              new: currFK,
            });
          }
        }
      }

      for (const fkName in prevFKs) {
        if (!(fkName in currFKs)) {
          const prevFK = prevFKs[fkName];
          diff.foreignKeys.deleted.push({
            ...prevFK,
            tableFrom: tableName,
          } as SchemaForeignKey);
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
