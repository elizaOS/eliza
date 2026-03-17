import { is, SQL } from "drizzle-orm";
import { getTableConfig, type MySqlColumn, MySqlDialect, MySqlTable } from "drizzle-orm/mysql-core";
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

// Drizzle schema type - an object mapping table names to MySqlTable instances
type DrizzleSchema = Record<string, unknown>;

/**
 * Internal Drizzle types for working with SQL expressions and indexes.
 */
interface SqlToQueryConfig {
  escapeName: () => never;
  escapeParam: () => never;
  escapeString: () => never;
  casing?: undefined;
}

/**
 * Internal Drizzle column config interface.
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
 * Utility functions
 */
function escapeSingleQuotes(str: string): string {
  return str.replace(/'/g, "''");
}

/**
 * Convert a Drizzle SQL expression to a string.
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
    casing: undefined,
  };
  type ToQueryParam = Parameters<SQL["toQuery"]>[0];
  return sql.toQuery(config as ToQueryParam).sql;
};

/**
 * Extract Drizzle tables from a schema object
 */
function extractTablesFromSchema(schema: DrizzleSchema): MySqlTable[] {
  const tables: MySqlTable[] = [];

  const exports = Object.values(schema);
  exports.forEach((t: unknown) => {
    if (is(t, MySqlTable)) {
      tables.push(t);
    }
  });

  return tables;
}

/**
 * Generate a snapshot from a Drizzle schema
 * MySQL port of the PostgreSQL snapshot generator
 */
export async function generateSnapshot(schema: DrizzleSchema): Promise<SchemaSnapshot> {
  const dialect = new MySqlDialect({ casing: undefined });
  const tables: Record<string, SchemaTable> = {};
  const schemas: Record<string, string> = {};
  const enums: Record<string, SchemaEnum> = {};

  const mysqlTables = extractTablesFromSchema(schema);

  for (const table of mysqlTables) {
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

    // Process columns
    columns.forEach((column: MySqlColumn) => {
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

      // Handle defaults
      if (column.default !== undefined) {
        if (is(column.default, SQL)) {
          columnToSet.default = sqlToStr(column.default, undefined);
        } else {
          if (typeof column.default === "string") {
            columnToSet.default = `'${escapeSingleQuotes(column.default)}'`;
          } else {
            if (sqlTypeLowered === "json") {
              columnToSet.default = `'${JSON.stringify(column.default)}'`;
            } else if (column.default instanceof Date) {
              if (sqlTypeLowered === "date") {
                columnToSet.default = `'${column.default.toISOString().split("T")[0]}'`;
              } else if (sqlTypeLowered === "timestamp") {
                columnToSet.default = `'${column.default
                  .toISOString()
                  .replace("T", " ")
                  .slice(0, 23)}'`;
              } else {
                columnToSet.default = `'${column.default.toISOString()}'`;
              }
            } else {
              columnToSet.default = column.default as string | number | boolean;
            }
          }
        }
      }

      // Handle column-level unique constraints
      const columnWithConfig = column as unknown as DrizzleColumnWithConfig;
      const columnConfig = columnWithConfig.config;
      if (columnWithConfig.isUnique && columnConfig && columnConfig.uniqueName) {
        uniqueConstraintObject[columnConfig.uniqueName] = {
          name: columnConfig.uniqueName,
          columns: [name],
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
    }

    // Process unique constraints
    uniqueConstraints?.forEach((unq: DrizzleUniqueConstraint) => {
      const columnNames = unq.columns.map((c) => c.name);
      const name = unq.name || `${tableName}_${columnNames.join("_")}_unique`;

      uniqueConstraintObject[name] = {
        name,
        columns: columnNames,
      };
    });

    // Drizzle foreign key interfaces
    interface DrizzleForeignKeyReference {
      columns: Array<{ name: string }>;
      foreignColumns: Array<{ name: string }>;
      foreignTable: MySqlTable;
    }

    interface DrizzleForeignKey {
      reference: () => DrizzleForeignKeyReference;
      getName: () => string;
      onDelete?: string;
      onUpdate?: string;
    }

    // Process foreign keys
    foreignKeys.forEach((fk: DrizzleForeignKey) => {
      const reference = fk.reference();
      const columnsFrom = reference.columns.map((it) => it.name);
      const columnsTo = reference.foreignColumns.map((it) => it.name);
      const tableTo = getTableConfig(reference.foreignTable).name;
      const schemaTo = getTableConfig(reference.foreignTable).schema || "";

      const name = fk.getName();

      foreignKeysObject[name] = {
        name,
        tableFrom: tableName,
        schemaFrom: tableSchema,
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
    // MySQL doesn't have schemas like PostgreSQL - use database name or empty string
    const schemaKey = tableSchema || "";
    tables[schemaKey ? `${schemaKey}.${tableName}` : tableName] = {
      name: tableName,
      schema: schemaKey,
      columns: columnsObject,
      indexes: indexesObject,
      foreignKeys: foreignKeysObject,
      compositePrimaryKeys: primaryKeysObject,
      uniqueConstraints: uniqueConstraintObject,
      checkConstraints: checksObject,
    };
  }

  const snapshot: SchemaSnapshot = {
    version: "7",
    dialect: "mysql",
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
    dialect: "mysql",
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
  if (!previousSnapshot) {
    return Object.keys(currentSnapshot.tables).length > 0;
  }

  const prevHash = hashSnapshot(previousSnapshot);
  const currHash = hashSnapshot(currentSnapshot);

  return prevHash !== currHash;
}
