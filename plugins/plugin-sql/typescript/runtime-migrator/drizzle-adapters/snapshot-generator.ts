import { is, SQL } from "drizzle-orm";
import { getTableConfig, type PgColumn, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { extendedHash } from "../crypto-utils";
import type {
  IndexColumn,
  SchemaCheckConstraint,
  SchemaColumn,
  SchemaEnum,
  SchemaForeignKey,
  SchemaIndex,
  SchemaPrimaryKey,
  SchemaSnapshot,
  SchemaTable,
  SchemaUniqueConstraint,
} from "../types";

// Drizzle schema type - an object mapping table names to PgTable instances
type DrizzleSchema = Record<string, unknown>;

// Array element type for building SQL arrays
type ArrayElement = number | bigint | boolean | string | Date | object | ArrayElement[];

/**
 * Internal Drizzle types for working with SQL expressions and indexes.
 * These types aren't exported from drizzle-orm but are needed for snapshot generation.
 *
 * Note: Drizzle's SQL.toQuery() accepts a config object with specific properties.
 * Since these are internal to Drizzle, we define compatible types here.
 */
interface SqlToQueryConfig {
  escapeName: () => never;
  escapeParam: () => never;
  escapeString: () => never;
  casing?: undefined; // We don't use casing transformation
}

/**
 * Internal Drizzle column config interface.
 * PgColumn has internal properties not exposed in the public type definition.
 */
interface DrizzleColumnWithConfig {
  name: string;
  notNull: boolean;
  primary: boolean;
  getSQLType: () => string;
  default?: unknown;
  isUnique?: boolean;
  config?: {
    uniqueName?: string;
    uniqueType?: string;
  };
}

/**
 * Utility functions from Drizzle's code
 */
function escapeSingleQuotes(str: string): string {
  return str.replace(/'/g, "''");
}

function isPgArrayType(sqlType: string): boolean {
  return sqlType.match(/.*\[\d*\].*|.*\[\].*/g) !== null;
}

function buildArrayString(array: ArrayElement[], sqlType: string): string {
  sqlType = sqlType.split("[")[0];
  const values = array
    .map((value) => {
      if (typeof value === "number" || typeof value === "bigint") {
        return value.toString();
      } else if (typeof value === "boolean") {
        return value ? "true" : "false";
      } else if (Array.isArray(value)) {
        return buildArrayString(value, sqlType);
      } else if (value instanceof Date) {
        if (sqlType === "date") {
          return `"${value.toISOString().split("T")[0]}"`;
        } else if (sqlType === "timestamp") {
          return `"${value.toISOString().replace("T", " ").slice(0, 23)}"`;
        } else {
          return `"${value.toISOString()}"`;
        }
      } else if (typeof value === "object") {
        return `"${JSON.stringify(value).replaceAll('"', '\\"')}"`;
      }

      return `"${value}"`;
    })
    .join(",");

  return `{${values}}`;
}

/**
 * Convert a Drizzle SQL expression to a string.
 * This is used for extracting default values from column definitions.
 *
 * Note: We use a type assertion here because SQL.toQuery() expects internal
 * Drizzle types that aren't publicly exported. Our config is compatible
 * at runtime but TypeScript can't verify this.
 */
const sqlToStr = (sql: SQL, _casing: string | undefined) => {
  const config: SqlToQueryConfig = {
    escapeName: () => {
      throw new Error("we don't support params for `sql` default values");
    },
    escapeParam: () => {
      throw new Error("we don't support params for `sql` default values");
    },
    escapeString: () => {
      throw new Error("we don't support params for `sql` default values");
    },
    casing: undefined, // We don't use casing transformation in this context
  };
  // Type assertion needed: SQL.toQuery expects internal Drizzle types
  type ToQueryParam = Parameters<SQL["toQuery"]>[0];
  return sql.toQuery(config as ToQueryParam).sql;
};

/**
 * Extract Drizzle tables from a schema object
 */
function extractTablesFromSchema(schema: DrizzleSchema): PgTable[] {
  const tables: PgTable[] = [];

  // Iterate through all exports in the schema
  const exports = Object.values(schema);
  exports.forEach((t: unknown) => {
    // Check if it's a PgTable using Drizzle's is() function
    if (is(t, PgTable)) {
      tables.push(t);
    }
  });

  return tables;
}

/**
 * Generate a snapshot from a Drizzle schema
 * This is a port of Drizzle's pgSerializer.generatePgSnapshot
 */
export async function generateSnapshot(schema: DrizzleSchema): Promise<SchemaSnapshot> {
  const dialect = new PgDialect({ casing: undefined });
  const tables: Record<string, SchemaTable> = {};
  const schemas: Record<string, string> = {};
  const enums: Record<string, SchemaEnum> = {};

  // Extract tables from schema
  const pgTables = extractTablesFromSchema(schema);

  // Process each table
  for (const table of pgTables) {
    const config = getTableConfig(table);
    const {
      name: tableName,
      columns,
      indexes,
      foreignKeys,
      schema: tableSchema,
      primaryKeys,
      uniqueConstraints,
      checks,
    } = config;

    const columnsObject: Record<string, SchemaColumn> = {};
    const indexesObject: Record<string, SchemaIndex> = {};
    const foreignKeysObject: Record<string, SchemaForeignKey> = {};
    const primaryKeysObject: Record<string, SchemaPrimaryKey> = {};
    const uniqueConstraintObject: Record<string, SchemaUniqueConstraint> = {};
    const checksObject: Record<string, SchemaCheckConstraint> = {};

    // Process columns - EXACT copy of Drizzle's logic
    columns.forEach((column: PgColumn) => {
      const name = column.name;
      const notNull = column.notNull;
      const primaryKey = column.primary;
      const sqlType = column.getSQLType();
      const sqlTypeLowered = sqlType.toLowerCase();

      const columnToSet: SchemaColumn = {
        name,
        type: sqlType,
        primaryKey,
        notNull,
      };

      // Handle defaults - EXACT copy from Drizzle's pgSerializer.ts lines 247-273
      if (column.default !== undefined) {
        if (is(column.default, SQL)) {
          columnToSet.default = sqlToStr(column.default, undefined);
        } else {
          if (typeof column.default === "string") {
            columnToSet.default = `'${escapeSingleQuotes(column.default)}'`;
          } else {
            if (sqlTypeLowered === "jsonb" || sqlTypeLowered === "json") {
              columnToSet.default = `'${JSON.stringify(column.default)}'::${sqlTypeLowered}`;
            } else if (column.default instanceof Date) {
              if (sqlTypeLowered === "date") {
                columnToSet.default = `'${column.default.toISOString().split("T")[0]}'`;
              } else if (sqlTypeLowered === "timestamp") {
                columnToSet.default = `'${column.default.toISOString().replace("T", " ").slice(0, 23)}'`;
              } else {
                columnToSet.default = `'${column.default.toISOString()}'`;
              }
            } else if (isPgArrayType(sqlTypeLowered) && Array.isArray(column.default)) {
              columnToSet.default = `'${buildArrayString(column.default as ArrayElement[], sqlTypeLowered)}'`;
            } else {
              // Should do for all types
              // columnToSet.default = `'${column.default}'::${sqlTypeLowered}`;
              columnToSet.default = column.default as string | number | boolean;
            }
          }
        }
      }

      // Handle column-level unique constraints
      // IMPORTANT: Check isUnique, not just uniqueName presence!
      // Drizzle sets uniqueName for all columns but only unique ones should have constraints
      // Type assertion: accessing internal Drizzle column properties not in public types
      const columnWithConfig = column as unknown as DrizzleColumnWithConfig;
      const columnConfig = columnWithConfig.config;
      if (columnWithConfig.isUnique && columnConfig && columnConfig.uniqueName) {
        uniqueConstraintObject[columnConfig.uniqueName] = {
          name: columnConfig.uniqueName,
          columns: [name],
          nullsNotDistinct: columnConfig.uniqueType === "not distinct",
        };
      }

      columnsObject[name] = columnToSet;
    });

    // Drizzle primary key interface
    interface DrizzlePrimaryKey {
      columns: Array<{ name: string }>;
      getName: () => string;
    }

    // Process primary keys
    primaryKeys.forEach((pk: DrizzlePrimaryKey) => {
      const columnNames = pk.columns.map((c) => c.name);
      const name = pk.getName();

      primaryKeysObject[name] = {
        name,
        columns: columnNames,
      };
    });

    // Drizzle unique constraint interface
    interface DrizzleUniqueConstraint {
      columns: Array<{ name: string }>;
      name?: string;
      nullsNotDistinct?: boolean;
    }

    // Process unique constraints
    uniqueConstraints?.forEach((unq: DrizzleUniqueConstraint) => {
      const columnNames = unq.columns.map((c) => c.name);
      const name = unq.name || `${tableName}_${columnNames.join("_")}_unique`;

      uniqueConstraintObject[name] = {
        name,
        columns: columnNames,
        nullsNotDistinct: unq.nullsNotDistinct,
      };
    });

    // Drizzle foreign key interfaces
    interface DrizzleForeignKeyReference {
      columns: Array<{ name: string }>;
      foreignColumns: Array<{ name: string }>;
      foreignTable: PgTable;
    }

    interface DrizzleForeignKey {
      reference: () => DrizzleForeignKeyReference;
      getName: () => string;
      onDelete?: string;
      onUpdate?: string;
    }

    // Process foreign keys - includes both explicit foreignKeys and inline references
    // Drizzle's getTableConfig automatically collects inline .references() into foreignKeys
    foreignKeys.forEach((fk: DrizzleForeignKey) => {
      const reference = fk.reference();
      const columnsFrom = reference.columns.map((it) => it.name);
      const columnsTo = reference.foreignColumns.map((it) => it.name);
      const tableTo = getTableConfig(reference.foreignTable).name;
      const schemaTo = getTableConfig(reference.foreignTable).schema || "public";

      const name = fk.getName();

      foreignKeysObject[name] = {
        name,
        tableFrom: tableName,
        schemaFrom: tableSchema, // Add source table schema
        tableTo,
        schemaTo,
        columnsFrom,
        columnsTo,
        onDelete: fk.onDelete || "no action",
        onUpdate: fk.onUpdate || "no action",
      };
    });

    // Drizzle index interfaces
    interface DrizzleIndexConfig {
      order?: string;
      nulls?: string;
    }

    interface DrizzleIndexColumn {
      name: string;
      indexConfig?: DrizzleIndexConfig;
    }

    interface DrizzleIndex {
      config: {
        columns: Array<DrizzleIndexColumn | SQL>;
        name?: string;
        unique?: boolean;
        method?: string;
      };
    }

    // Process indexes
    // Drizzle's getTableConfig returns indexes with internal types not exported from the package
    (indexes as DrizzleIndex[]).forEach((idx: DrizzleIndex) => {
      const indexCols = idx.config.columns;
      const indexColumns: IndexColumn[] = indexCols.map((col) => {
        if (is(col, SQL)) {
          return {
            expression: dialect.sqlToQuery(col).sql,
            isExpression: true,
          };
        } else {
          const indexCol: IndexColumn = {
            expression: col.name,
            isExpression: false,
            asc: col.indexConfig && col.indexConfig.order === "asc",
          };
          // Only add nulls if explicitly specified in the config
          if (col.indexConfig?.nulls) {
            indexCol.nulls = col.indexConfig.nulls;
          }
          return indexCol;
        }
      });

      const name =
        idx.config.name || `${tableName}_${indexColumns.map((c) => c.expression).join("_")}_index`;

      indexesObject[name] = {
        name,
        columns: indexColumns,
        isUnique: idx.config.unique || false,
        method: idx.config.method || "btree",
      };
    });

    // Drizzle check constraint interface
    interface DrizzleCheck {
      name: string;
      value: SQL;
    }

    // Process check constraints
    if (checks) {
      checks.forEach((check: DrizzleCheck) => {
        const checkName = check.name;
        checksObject[checkName] = {
          name: checkName,
          value: dialect.sqlToQuery(check.value).sql,
        };
      });
    }

    // Build the table object
    tables[`${tableSchema || "public"}.${tableName}`] = {
      name: tableName,
      schema: tableSchema || "public",
      columns: columnsObject,
      indexes: indexesObject,
      foreignKeys: foreignKeysObject,
      compositePrimaryKeys: primaryKeysObject,
      uniqueConstraints: uniqueConstraintObject,
      checkConstraints: checksObject,
    };

    // Track schemas
    if (tableSchema && tableSchema !== "public") {
      schemas[tableSchema] = tableSchema;
    }
  }

  // Create snapshot in Drizzle's format
  const snapshot: SchemaSnapshot = {
    version: "7",
    dialect: "postgresql",
    tables,
    schemas,
    enums,
    _meta: {
      schemas: {},
      tables: {},
      columns: {},
    },
  };

  return snapshot;
}

/**
 * Calculate hash of a snapshot for change detection
 * Uses a browser-compatible hash function
 */
export function hashSnapshot(snapshot: SchemaSnapshot): string {
  const content = JSON.stringify(snapshot);
  return extendedHash(content);
}

/**
 * Create an empty snapshot for initial migration
 */
export function createEmptySnapshot(): SchemaSnapshot {
  return {
    version: "7",
    dialect: "postgresql",
    tables: {},
    schemas: {},
    enums: {},
    _meta: {
      schemas: {},
      tables: {},
      columns: {},
    },
  };
}

/**
 * Compare two snapshots and detect if there are changes
 */
export function hasChanges(
  previousSnapshot: SchemaSnapshot | null,
  currentSnapshot: SchemaSnapshot
): boolean {
  // If no previous snapshot, there are definitely changes
  if (!previousSnapshot) {
    return Object.keys(currentSnapshot.tables).length > 0;
  }

  // Simple comparison for now - in production, use deep comparison
  const prevHash = hashSnapshot(previousSnapshot);
  const currHash = hashSnapshot(currentSnapshot);

  return prevHash !== currHash;
}
