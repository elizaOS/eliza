import type {
  IPluginStore,
  PluginFilter,
  PluginFilterValue,
  PluginOrderBy,
  PluginQueryOptions,
  PluginSchema,
  PluginTableSchema,
  UUID,
  logger as Logger,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { and, asc, desc, eq, gt, gte, inArray, lt, lte, type SQL, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { pgTable, text, uuid as pgUuid, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

/**
 * SQL Plugin Store Implementation
 * 
 * WHY: Provides a generic CRUD interface for plugin tables without requiring
 * plugins to know about Drizzle ORM specifics.
 * 
 * DESIGN: Creates Drizzle table definitions dynamically from PluginTableSchema,
 * then uses standard Drizzle operations for all queries.
 * 
 * NOTE: Uses generic `any` for database type to support both PG and MySQL Drizzle instances.
 */
export class SqlPluginStore implements IPluginStore {
  private db: any;
  private pluginName: string;
  private tableCache: Map<string, PgTable> = new Map();
  private dialect: "pg" | "mysql";

  constructor(db: any, pluginName: string) {
    this.db = db;
    this.pluginName = pluginName;
    // Detect dialect from the Drizzle instance
    // WHY: We need to use different SQL syntax for PostgreSQL vs MySQL
    this.dialect = this.detectDialect(db);
  }

  /**
   * Detect database dialect from Drizzle instance
   * 
   * WHY: PostgreSQL and MySQL have different SQL syntax for operations like
   * checking if tables exist, array operations, and UPSERT
   */
  private detectDialect(db: any): "pg" | "mysql" {
    // Check for MySQL-specific properties
    if (db.constructor.name.toLowerCase().includes("mysql") || 
        db._.session?.constructor.name.toLowerCase().includes("mysql")) {
      return "mysql";
    }
    // Default to PostgreSQL
    return "pg";
  }

  /**
   * Get prefixed table name
   * 
   * WHY: Namespace plugin tables to avoid conflicts
   * Example: plugin "goals", table "goals" -> "goals_goals"
   */
  private getTableName(table: string): string {
    return `${this.pluginName}_${table}`;
  }

  /**
   * Get or create Drizzle table definition
   * 
   * WHY: We need Drizzle table objects for queries, but we only have
   * the schema definition. Create them dynamically and cache.
   */
  private getTable(tableName: string): PgTable {
    const fullName = this.getTableName(tableName);
    
    if (this.tableCache.has(fullName)) {
      return this.tableCache.get(fullName)!;
    }

    // Create a minimal table definition for querying
    // We don't need the full schema here, just enough to query
    const table = pgTable(fullName, {
      id: pgUuid("id").primaryKey(),
      // Note: Other columns will be accessed via dynamic SQL
    });

    this.tableCache.set(fullName, table);
    return table;
  }

  /**
   * Build WHERE clause from filter
   */
  private buildWhere(table: PgTable, filter?: PluginFilter): SQL | undefined {
    if (!filter || Object.keys(filter).length === 0) {
      return undefined;
    }

    const conditions: SQL[] = [];

    for (const [key, value] of Object.entries(filter)) {
      const column = sql.identifier(key);

      if (value === null) {
        conditions.push(sql`${column} IS NULL`);
      } else if (typeof value === "object" && value !== null) {
        // Handle operators
        if ("$in" in value && Array.isArray(value.$in)) {
          conditions.push(sql`${column} = ANY(${value.$in})`);
        } else if ("$gt" in value) {
          conditions.push(sql`${column} > ${value.$gt}`);
        } else if ("$gte" in value) {
          conditions.push(sql`${column} >= ${value.$gte}`);
        } else if ("$lt" in value) {
          conditions.push(sql`${column} < ${value.$lt}`);
        } else if ("$lte" in value) {
          conditions.push(sql`${column} <= ${value.$lte}`);
        }
      } else {
        // Simple equality
        conditions.push(sql`${column} = ${value}`);
      }
    }

    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  /**
   * Build ORDER BY clause
   */
  private buildOrderBy(orderBy?: PluginOrderBy | PluginOrderBy[]): SQL[] {
    if (!orderBy) return [];

    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    return orders.map((o) => {
      const column = sql.identifier(o.column);
      return o.direction === "asc" ? sql`${column} ASC` : sql`${column} DESC`;
    });
  }

  async query<T = Record<string, unknown>>(
    table: string,
    filter?: PluginFilter,
    options?: PluginQueryOptions,
  ): Promise<T[]> {
    const fullTableName = this.getTableName(table);
    const drizzleTable = this.getTable(table);

    try {
      let query = this.db.select().from(drizzleTable);

      // Apply WHERE clause
      const whereClause = this.buildWhere(drizzleTable, filter);
      if (whereClause) {
        query = query.where(whereClause) as any;
      }

      // Build ORDER BY
      const orderClauses = this.buildOrderBy(options?.orderBy);
      if (orderClauses.length > 0) {
        query = query.orderBy(...orderClauses) as any;
      }

      // Apply LIMIT/OFFSET
      if (options?.limit) {
        query = query.limit(options.limit) as any;
      }
      if (options?.offset) {
        query = query.offset(options.offset) as any;
      }

      const results = await query;
      return results as T[];
    } catch (error) {
      logger.error(
        {
          src: "plugin:sql:store",
          pluginName: this.pluginName,
          table: fullTableName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to query plugin table"
      );
      throw error;
    }
  }

  async getById<T = Record<string, unknown>>(
    table: string,
    id: UUID,
  ): Promise<T | null> {
    const results = await this.query<T>(table, { id: id as string });
    return results[0] || null;
  }

  async insert(
    table: string,
    rows: Record<string, unknown>[],
  ): Promise<UUID[]> {
    if (rows.length === 0) return [];

    const fullTableName = this.getTableName(table);
    const drizzleTable = this.getTable(table);

    try {
      // Use raw SQL for insert since we don't have full column definitions
      const columns = Object.keys(rows[0]);
      const columnNames = columns.map((c) => sql.identifier(c));
      const values = rows.map((row) => 
        sql`(${sql.join(columns.map((c) => sql`${row[c]}`), sql`, `)})`
      );

      // Handle dialect differences for RETURNING clause
      if (this.dialect === "pg") {
        const insertQuery = sql`
          INSERT INTO ${sql.identifier(fullTableName)} (${sql.join(columnNames, sql`, `)})
          VALUES ${sql.join(values, sql`, `)}
          RETURNING id
        `;

        const result = await this.db.execute(insertQuery);
        
        // Extract IDs from result
        const ids: UUID[] = [];
        if (Array.isArray(result)) {
          for (const row of result) {
            if (row && typeof row === "object" && "id" in row) {
              ids.push(row.id as UUID);
            }
          }
        }

        return ids;
      } else {
        // MySQL doesn't support RETURNING, so extract IDs from the input rows
        const insertQuery = sql`
          INSERT INTO ${sql.identifier(fullTableName)} (${sql.join(columnNames, sql`, `)})
          VALUES ${sql.join(values, sql`, `)}
        `;

        await this.db.execute(insertQuery);
        
        // Extract IDs from input rows (they must have been provided by caller)
        return rows.map((row) => row.id as UUID);
      }
    } catch (error) {
      logger.error(
        {
          src: "plugin:sql:store",
          pluginName: this.pluginName,
          table: fullTableName,
          count: rows.length,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to insert into plugin table"
      );
      throw error;
    }
  }

  async update(
    table: string,
    filter: PluginFilter,
    set: Record<string, unknown>,
  ): Promise<number> {
    const fullTableName = this.getTableName(table);
    const drizzleTable = this.getTable(table);

    try {
      const whereClause = this.buildWhere(drizzleTable, filter);
      if (!whereClause) {
        throw new Error("Update requires a filter (safety check)");
      }

      // Build SET clause
      const setClauses = Object.entries(set).map(([key, value]) =>
        sql`${sql.identifier(key)} = ${value}`
      );

      const updateQuery = sql`
        UPDATE ${sql.identifier(fullTableName)}
        SET ${sql.join(setClauses, sql`, `)}
        WHERE ${whereClause}
      `;

      const result = await this.db.execute(updateQuery);
      
      // Extract row count from result
      if (result && typeof result === "object" && "rowCount" in result) {
        return (result.rowCount as number) || 0;
      }
      
      return 0;
    } catch (error) {
      logger.error(
        {
          src: "plugin:sql:store",
          pluginName: this.pluginName,
          table: fullTableName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to update plugin table"
      );
      throw error;
    }
  }

  async delete(
    table: string,
    filter: PluginFilter,
  ): Promise<number> {
    const fullTableName = this.getTableName(table);
    const drizzleTable = this.getTable(table);

    try {
      const whereClause = this.buildWhere(drizzleTable, filter);
      if (!whereClause) {
        throw new Error("Delete requires a filter (safety check)");
      }

      const deleteQuery = sql`
        DELETE FROM ${sql.identifier(fullTableName)}
        WHERE ${whereClause}
      `;

      const result = await this.db.execute(deleteQuery);
      
      if (result && typeof result === "object" && "rowCount" in result) {
        return (result.rowCount as number) || 0;
      }
      
      return 0;
    } catch (error) {
      logger.error(
        {
          src: "plugin:sql:store",
          pluginName: this.pluginName,
          table: fullTableName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to delete from plugin table"
      );
      throw error;
    }
  }

  async count(
    table: string,
    filter?: PluginFilter,
  ): Promise<number> {
    const fullTableName = this.getTableName(table);
    const drizzleTable = this.getTable(table);

    try {
      const whereClause = this.buildWhere(drizzleTable, filter);
      
      const countQuery = whereClause
        ? sql`SELECT COUNT(*) as count FROM ${sql.identifier(fullTableName)} WHERE ${whereClause}`
        : sql`SELECT COUNT(*) as count FROM ${sql.identifier(fullTableName)}`;

      const result = await this.db.execute(countQuery);
      
      if (Array.isArray(result) && result.length > 0) {
        const row = result[0];
        if (row && typeof row === "object" && "count" in row) {
          return Number(row.count);
        }
      }
      
      return 0;
    } catch (error) {
      logger.error(
        {
          src: "plugin:sql:store",
          pluginName: this.pluginName,
          table: fullTableName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to count plugin table rows"
      );
      throw error;
    }
  }
}

/**
 * Detect database dialect from Drizzle instance
 * WHY: We need different SQL syntax for PostgreSQL vs MySQL
 */
function detectDbDialect(db: any): "pg" | "mysql" {
  if (db.constructor.name.toLowerCase().includes("mysql") || 
      db._.session?.constructor.name.toLowerCase().includes("mysql")) {
    return "mysql";
  }
  return "pg";
}

/**
 * Register a plugin schema in the database
 * 
 * WHY: Creates tables, columns, and indexes for a plugin's custom data.
 * Idempotent - safe to call multiple times.
 */
export async function registerPluginSchema(
  db: any,
  schema: PluginSchema,
): Promise<void> {
  const { pluginName, tables } = schema;
  const dialect = detectDbDialect(db);

  try {
    for (const table of tables) {
      const fullTableName = `${pluginName}_${table.name}`;
      
      // Check if table exists (dialect-specific)
      let tableExistsQuery: SQL;
      if (dialect === "pg") {
        tableExistsQuery = sql`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = ${fullTableName}
          ) as exists
        `;
      } else {
        // MySQL
        tableExistsQuery = sql`
          SELECT COUNT(*) as count
          FROM information_schema.tables 
          WHERE table_schema = DATABASE()
          AND table_name = ${fullTableName}
        `;
      }
      
      const result = await db.execute(tableExistsQuery);
      let exists = false;
      if (dialect === "pg") {
        exists = Array.isArray(result) && result[0] && 
          typeof result[0] === "object" && "exists" in result[0] && result[0].exists;
      } else {
        exists = Array.isArray(result) && result[0] && 
          typeof result[0] === "object" && "count" in result[0] && Number(result[0].count) > 0;
      }

      if (!exists) {
        // Create table
        await createPluginTable(db, pluginName, table, dialect);
      } else {
        // Table exists - check for schema changes (migrations)
        await migratePluginTable(db, pluginName, table, dialect);
      }
    }

    logger.info(
      { src: "plugin:sql:schema", pluginName, tableCount: tables.length },
      "Plugin schema registered successfully"
    );
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql:schema",
        pluginName,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to register plugin schema"
    );
    throw error;
  }
}

/**
 * Create a new plugin table
 */
async function createPluginTable(
  db: any,
  pluginName: string,
  table: PluginTableSchema,
  dialect: "pg" | "mysql",
): Promise<void> {
  const fullTableName = `${pluginName}_${table.name}`;
  
  // Build column definitions
  const columnDefs = table.columns.map((col) => {
    const parts: string[] = [col.name];
    
    // Map type (dialect-specific)
    switch (col.type) {
      case "uuid":
        parts.push(dialect === "pg" ? "UUID" : "CHAR(36)");
        break;
      case "string":
        parts.push("VARCHAR(255)");
        break;
      case "text":
        parts.push("TEXT");
        break;
      case "integer":
        parts.push("INTEGER");
        break;
      case "boolean":
        parts.push(dialect === "pg" ? "BOOLEAN" : "TINYINT(1)");
        break;
      case "timestamp":
        parts.push("TIMESTAMP");
        break;
      case "jsonb":
        parts.push(dialect === "pg" ? "JSONB" : "JSON");
        break;
    }
    
    // Add constraints
    if (col.primaryKey) parts.push("PRIMARY KEY");
    if (col.notNull) parts.push("NOT NULL");
    if (col.default !== undefined) {
      if (typeof col.default === "string") {
        parts.push(`DEFAULT '${col.default}'`);
      } else if (col.default === null) {
        parts.push("DEFAULT NULL");
      } else {
        parts.push(`DEFAULT ${col.default}`);
      }
    }
    
    return parts.join(" ");
  });

  const createTableQuery = sql.raw(`
    CREATE TABLE ${fullTableName} (
      ${columnDefs.join(",\n      ")}
    )
  `);

  await db.execute(createTableQuery);

  // Create indexes
  if (table.indexes) {
    for (const index of table.indexes) {
      const indexName = `${fullTableName}_${index.name}`;
      const unique = index.unique ? "UNIQUE" : "";
      const columns = index.columns.join(", ");
      
      const createIndexQuery = sql.raw(`
        CREATE ${unique} INDEX ${indexName} ON ${fullTableName} (${columns})
      `);
      
      await db.execute(createIndexQuery);
    }
  }

  logger.info(
    { src: "plugin:sql:schema", table: fullTableName },
    "Created plugin table"
  );
}

/**
 * Migrate an existing plugin table
 * 
 * WHY: When a plugin updates its schema, we need to apply changes.
 * For now, this is a placeholder - full migration support would diff
 * the current schema and apply ALTER TABLE statements.
 */
async function migratePluginTable(
  db: any,
  pluginName: string,
  table: PluginTableSchema,
  dialect: "pg" | "mysql",
): Promise<void> {
  // TODO: Implement schema diffing and migration
  // For now, just log that the table exists
  logger.debug(
    { src: "plugin:sql:schema", table: `${pluginName}_${table.name}` },
    "Plugin table already exists (migration not yet implemented)"
  );
}
