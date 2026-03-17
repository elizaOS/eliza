import { logger } from "@elizaos/core";
import { sql } from "drizzle-orm";
import type {
  CheckConstraintInfoRow,
  ColumnInfoRow,
  DrizzleDB,
  ForeignKeyInfoRow,
  IndexInfoRow,
  PrimaryKeyInfoRow,
  SchemaCheckConstraint,
  SchemaColumn,
  SchemaEnum,
  SchemaForeignKey,
  SchemaIndex,
  SchemaPrimaryKey,
  SchemaSnapshot,
  SchemaTable,
  SchemaUniqueConstraint,
  UniqueConstraintInfoRow,
} from "../types";

/**
 * Type-safe extraction of rows from MySQL query results.
 * MySQL2's execute returns [rows, fields] tuple.
 */
function getRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) {
    return (result[0] || []) as T[];
  }
  return [];
}

/**
 * Introspect the current MySQL database state and generate a snapshot.
 * Uses INFORMATION_SCHEMA views instead of PostgreSQL system catalogs.
 */
export class DatabaseIntrospector {
  constructor(private db: DrizzleDB) {}

  /**
   * Introspect all tables in the database and generate a snapshot
   * @param databaseName - Database to introspect (default: current database)
   * @returns Schema snapshot of current database state
   */
  async introspectSchema(databaseName?: string): Promise<SchemaSnapshot> {
    // If no database name provided, get the current one
    if (!databaseName) {
      const dbResult = await this.db.execute(sql`SELECT DATABASE() as db_name`);
      const dbRows = getRows<{ db_name: string }>(dbResult);
      databaseName = dbRows[0]?.db_name || "";
    }

    logger.info({ src: "plugin:mysql", databaseName }, "Starting database introspection");

    const tables: Record<string, SchemaTable> = {};
    const schemas: Record<string, string> = {};
    const enums: Record<string, SchemaEnum> = {};

    // Get all tables in the database
    const allTables = await this.getTables(databaseName);

    for (const tableInfo of allTables) {
      const tableName = tableInfo.TABLE_NAME;

      logger.debug({ src: "plugin:mysql", databaseName, tableName }, "Introspecting table");

      // Get columns for this table
      const columns = await this.getColumns(databaseName, tableName);
      const columnsObject: Record<string, SchemaColumn> = {};
      const uniqueConstraintObject: Record<string, SchemaUniqueConstraint> = {};

      for (const col of columns) {
        columnsObject[col.COLUMN_NAME] = {
          name: col.COLUMN_NAME,
          type: col.COLUMN_TYPE,
          primaryKey: col.COLUMN_KEY === "PRI",
          notNull: col.IS_NULLABLE === "NO",
          default: col.COLUMN_DEFAULT
            ? this.parseDefault(col.COLUMN_DEFAULT, col.DATA_TYPE)
            : undefined,
        };
      }

      // Get indexes
      const indexes = await this.getIndexes(databaseName, tableName);
      const indexesObject: Record<string, SchemaIndex> = {};

      // Group index columns by index name
      const indexGroups = new Map<
        string,
        { columns: string[]; isUnique: boolean; isPrimary: boolean; method: string }
      >();

      for (const idx of indexes) {
        const existing = indexGroups.get(idx.INDEX_NAME);
        if (existing) {
          existing.columns.push(idx.COLUMN_NAME);
        } else {
          indexGroups.set(idx.INDEX_NAME, {
            columns: [idx.COLUMN_NAME],
            isUnique: idx.NON_UNIQUE === 0,
            isPrimary: idx.INDEX_NAME === "PRIMARY",
            method: idx.INDEX_TYPE?.toLowerCase() || "btree",
          });
        }
      }

      for (const [indexName, indexInfo] of indexGroups) {
        if (!indexInfo.isPrimary) {
          indexesObject[indexName] = {
            name: indexName,
            columns: indexInfo.columns.map((col) => ({
              expression: col,
              isExpression: false,
            })),
            isUnique: indexInfo.isUnique,
            method: indexInfo.method,
          };
        }
      }

      // Get foreign keys
      const foreignKeys = await this.getForeignKeys(databaseName, tableName);
      const foreignKeysObject: Record<string, SchemaForeignKey> = {};

      // Group FK columns by constraint name
      const fkGroups = new Map<
        string,
        {
          columnsFrom: string[];
          columnsTo: string[];
          tableTo: string;
          schemaTo: string;
          deleteRule: string;
          updateRule: string;
        }
      >();

      for (const fk of foreignKeys) {
        const existing = fkGroups.get(fk.CONSTRAINT_NAME);
        if (existing) {
          existing.columnsFrom.push(fk.COLUMN_NAME);
          existing.columnsTo.push(fk.REFERENCED_COLUMN_NAME);
        } else {
          fkGroups.set(fk.CONSTRAINT_NAME, {
            columnsFrom: [fk.COLUMN_NAME],
            columnsTo: [fk.REFERENCED_COLUMN_NAME],
            tableTo: fk.REFERENCED_TABLE_NAME,
            schemaTo: fk.REFERENCED_TABLE_SCHEMA || "",
            deleteRule: fk.DELETE_RULE?.toLowerCase() || "no action",
            updateRule: fk.UPDATE_RULE?.toLowerCase() || "no action",
          });
        }
      }

      for (const [fkName, fkInfo] of fkGroups) {
        foreignKeysObject[fkName] = {
          name: fkName,
          tableFrom: tableName,
          schemaFrom: "",
          tableTo: fkInfo.tableTo,
          schemaTo: fkInfo.schemaTo,
          columnsFrom: fkInfo.columnsFrom,
          columnsTo: fkInfo.columnsTo,
          onDelete: fkInfo.deleteRule,
          onUpdate: fkInfo.updateRule,
        };
      }

      // Get primary keys
      const primaryKeys = await this.getPrimaryKeys(databaseName, tableName);
      const primaryKeysObject: Record<string, SchemaPrimaryKey> = {};

      if (primaryKeys.length > 0) {
        const pkName = primaryKeys[0].CONSTRAINT_NAME;
        primaryKeysObject[pkName] = {
          name: pkName,
          columns: primaryKeys.map((pk) => pk.COLUMN_NAME),
        };
      }

      // Get unique constraints
      const uniqueConstraints = await this.getUniqueConstraints(databaseName, tableName);

      // Group unique constraint columns by constraint name
      const uniqueGroups = new Map<string, string[]>();
      for (const unq of uniqueConstraints) {
        const existing = uniqueGroups.get(unq.CONSTRAINT_NAME);
        if (existing) {
          existing.push(unq.COLUMN_NAME);
        } else {
          uniqueGroups.set(unq.CONSTRAINT_NAME, [unq.COLUMN_NAME]);
        }
      }

      for (const [unqName, unqColumns] of uniqueGroups) {
        uniqueConstraintObject[unqName] = {
          name: unqName,
          columns: unqColumns,
        };
      }

      // Get check constraints (MySQL 8.0.16+)
      const checkConstraints = await this.getCheckConstraints(databaseName, tableName);
      const checksObject: Record<string, SchemaCheckConstraint> = {};

      for (const check of checkConstraints) {
        checksObject[check.CONSTRAINT_NAME] = {
          name: check.CONSTRAINT_NAME,
          value: check.CHECK_CLAUSE,
        };
      }

      // Build the table object
      tables[tableName] = {
        name: tableName,
        schema: "",
        columns: columnsObject,
        indexes: indexesObject,
        foreignKeys: foreignKeysObject,
        compositePrimaryKeys: primaryKeysObject,
        uniqueConstraints: uniqueConstraintObject,
        checkConstraints: checksObject,
      };
    }

    logger.info(
      { src: "plugin:mysql", tableCount: Object.keys(tables).length },
      "Database introspection complete"
    );

    return {
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
  }

  /**
   * Get all tables in a database
   */
  private async getTables(databaseName: string): Promise<{ TABLE_NAME: string }[]> {
    const result = await this.db.execute(
      sql`SELECT TABLE_NAME
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ${databaseName}
            AND TABLE_TYPE = 'BASE TABLE'
          ORDER BY TABLE_NAME`
    );
    return getRows<{ TABLE_NAME: string }>(result);
  }

  /**
   * Get columns for a table
   */
  private async getColumns(databaseName: string, tableName: string): Promise<ColumnInfoRow[]> {
    const result = await this.db.execute(
      sql`SELECT
            COLUMN_NAME,
            IS_NULLABLE,
            DATA_TYPE,
            COLUMN_TYPE,
            COLUMN_DEFAULT,
            COLUMN_KEY,
            EXTRA
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = ${databaseName}
            AND TABLE_NAME = ${tableName}
          ORDER BY ORDINAL_POSITION`
    );
    return getRows<ColumnInfoRow>(result);
  }

  /**
   * Get indexes for a table
   */
  private async getIndexes(databaseName: string, tableName: string): Promise<IndexInfoRow[]> {
    const result = await this.db.execute(
      sql`SELECT
            INDEX_NAME,
            NON_UNIQUE,
            COLUMN_NAME,
            SEQ_IN_INDEX,
            INDEX_TYPE
          FROM INFORMATION_SCHEMA.STATISTICS
          WHERE TABLE_SCHEMA = ${databaseName}
            AND TABLE_NAME = ${tableName}
          ORDER BY INDEX_NAME, SEQ_IN_INDEX`
    );
    return getRows<IndexInfoRow>(result);
  }

  /**
   * Get foreign keys for a table
   */
  private async getForeignKeys(
    databaseName: string,
    tableName: string
  ): Promise<ForeignKeyInfoRow[]> {
    const result = await this.db.execute(
      sql`SELECT
            kcu.CONSTRAINT_NAME,
            kcu.COLUMN_NAME,
            kcu.REFERENCED_TABLE_SCHEMA,
            kcu.REFERENCED_TABLE_NAME,
            kcu.REFERENCED_COLUMN_NAME,
            rc.DELETE_RULE,
            rc.UPDATE_RULE
          FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
          JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            ON kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
            AND kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
          WHERE kcu.TABLE_SCHEMA = ${databaseName}
            AND kcu.TABLE_NAME = ${tableName}
            AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
          ORDER BY kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`
    );
    return getRows<ForeignKeyInfoRow>(result);
  }

  /**
   * Get primary keys for a table
   */
  private async getPrimaryKeys(
    databaseName: string,
    tableName: string
  ): Promise<PrimaryKeyInfoRow[]> {
    const result = await this.db.execute(
      sql`SELECT
            tc.CONSTRAINT_NAME,
            kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
            AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
            AND tc.TABLE_NAME = kcu.TABLE_NAME
          WHERE tc.TABLE_SCHEMA = ${databaseName}
            AND tc.TABLE_NAME = ${tableName}
            AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
          ORDER BY kcu.ORDINAL_POSITION`
    );
    return getRows<PrimaryKeyInfoRow>(result);
  }

  /**
   * Get unique constraints for a table
   */
  private async getUniqueConstraints(
    databaseName: string,
    tableName: string
  ): Promise<UniqueConstraintInfoRow[]> {
    const result = await this.db.execute(
      sql`SELECT
            tc.CONSTRAINT_NAME,
            kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
            AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
            AND tc.TABLE_NAME = kcu.TABLE_NAME
          WHERE tc.TABLE_SCHEMA = ${databaseName}
            AND tc.TABLE_NAME = ${tableName}
            AND tc.CONSTRAINT_TYPE = 'UNIQUE'
          ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION`
    );
    return getRows<UniqueConstraintInfoRow>(result);
  }

  /**
   * Get check constraints for a table (MySQL 8.0.16+)
   */
  private async getCheckConstraints(
    databaseName: string,
    tableName: string
  ): Promise<CheckConstraintInfoRow[]> {
    try {
      const result = await this.db.execute(
        sql`SELECT
              CONSTRAINT_NAME,
              CHECK_CLAUSE
            FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = ${databaseName}
              AND TABLE_NAME = ${tableName}`
      );
      return getRows<CheckConstraintInfoRow>(result);
    } catch {
      // CHECK_CONSTRAINTS table may not exist in older MySQL versions
      return [];
    }
  }

  /**
   * Parse default value for a column
   */
  private parseDefault(defaultValue: string, dataType: string): string | undefined {
    if (!defaultValue || defaultValue === "NULL") return undefined;

    // Handle CURRENT_TIMESTAMP defaults
    if (defaultValue === "CURRENT_TIMESTAMP" || defaultValue.startsWith("CURRENT_TIMESTAMP")) {
      return defaultValue;
    }

    // Handle boolean defaults
    if (dataType === "tinyint") {
      if (defaultValue === "1") return "true";
      if (defaultValue === "0") return "false";
    }

    // Handle auto_increment (serial) - don't store as default
    if (defaultValue.includes("auto_increment")) {
      return undefined;
    }

    return defaultValue;
  }

  /**
   * Check if tables exist for a plugin
   * @param pluginName - Name of the plugin
   * @returns True if tables exist, false otherwise
   */
  async hasExistingTables(pluginName: string): Promise<boolean> {
    // For MySQL, check the current database for tables
    const dbResult = await this.db.execute(sql`SELECT DATABASE() as db_name`);
    const dbRows = getRows<{ db_name: string }>(dbResult);
    const databaseName = dbRows[0]?.db_name || "";

    const result = await this.db.execute(
      sql`SELECT COUNT(*) AS count
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_SCHEMA = ${databaseName}
            AND TABLE_TYPE = 'BASE TABLE'`
    );

    const rows = getRows<{ count: number | string }>(result);
    const count = parseInt(String(rows[0]?.count || "0"), 10);
    return count > 0;
  }
}
