/**
 * Drizzle Database Client
 *
 * Provides table repositories with findUnique, findFirst, findMany, create, update, delete methods.
 * 100% Drizzle ORM under the hood.
 *
 * Usage:
 *   import { db } from '@babylon/db';
 *   const user = await db.user.findUnique({ where: { id: '123' } });
 *   const users = await db.user.findMany({ where: { isActive: true } });
 */

import type { Param } from "drizzle-orm";
import {
  and,
  asc,
  desc,
  count as drizzleCount,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  getTableConfig,
  type PgColumn,
  type PgTable,
  type SelectedFields,
} from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import type postgres from "postgres";
import * as schema from "./schema";

// Helper to find column by name from table config
function findColumnByName(
  tableConfig: ReturnType<typeof getTableConfig>,
  name: string,
): PgColumn | undefined {
  // columns is an array, so we need to find by name property
  return tableConfig.columns.find((col) => col.name === name);
}

// Helper to safely cast table for Drizzle's from() method
// Drizzle requires specific table types, but our generic TTable extends PgTable
// We use a type assertion to PgTable which satisfies Drizzle's TableLikeHasEmptySelection check
// This is safe because TTable extends PgTable and we're using it correctly
function asDrizzleTable<T extends PgTable>(table: T): PgTable {
  return table as PgTable;
}

/**
 * Drizzle schema type representing all database tables.
 */
export type DrizzleSchema = typeof schema;
export type SchemaDatabase = PostgresJsDatabase<DrizzleSchema>;
export type SchemaTables = ExtractTablesWithRelations<DrizzleSchema>;
export type RelationalQueryAPI = SchemaDatabase["query"];

// JSON value type for nested structures
// This matches the JSON specification: all valid JSON value types
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonArray;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

// SQL value types - all valid types that can be used in SQL template strings and database columns
// Includes primitives, arrays, objects (JSON/JSONB), and SQL expressions
// Best Practice (2025): JSON columns should use .$type<JsonValue>() in schema for proper typing
export type SQLValue =
  | string
  | number
  | boolean
  | null
  | Date
  | SQL
  | Param
  | bigint
  | string[] // Array types for PostgreSQL arrays
  | number[]
  | boolean[]
  | JsonValue // JSON/JSONB objects and nested structures (proper type for JSON columns)
  | JsonValue[]; // Nested arrays

// Relational query config - properly typed for Drizzle's relational query builder
type RelationalQueryConfig = {
  where?: SQL;
  with?: Record<string, boolean | RelationalQueryConfig>;
  orderBy?: SQL[];
  limit?: number;
  offset?: number;
};

// Type for relational query builder methods - properly typed with generics
type RelationalQueryMethods<TResult = Record<string, SQLValue>> = {
  findFirst?: (config: RelationalQueryConfig) => Promise<TResult | null>;
  findMany?: (config: RelationalQueryConfig) => Promise<TResult[]>;
};

// Helper to safely access relational query builder
function getRelationalQueryBuilder<
  TResult extends Record<string, SQLValue> = Record<string, SQLValue>,
>(
  queryAPI: RelationalQueryAPI | undefined,
  tableName: string,
): RelationalQueryMethods<TResult> | null {
  if (!queryAPI) return null;
  const queryTable = queryAPI[tableName as keyof RelationalQueryAPI];
  if (!queryTable) return null;

  // Type guard to ensure it has the methods we need
  if ("findFirst" in queryTable || "findMany" in queryTable) {
    return {
      findFirst:
        "findFirst" in queryTable
          ? queryTable.findFirst.bind(queryTable)
          : undefined,
      findMany:
        "findMany" in queryTable
          ? queryTable.findMany.bind(queryTable)
          : undefined,
    } as RelationalQueryMethods<TResult>;
  }

  return null;
}

/**
 * Generic where condition type supporting various comparison operators.
 */
type WhereValue<T> =
  | T
  | {
      equals?: T;
      not?: T | { equals?: T };
      in?: T[];
      notIn?: T[];
      lt?: T;
      lte?: T;
      gt?: T;
      gte?: T;
      contains?: string;
      startsWith?: string;
      endsWith?: string;
      mode?: "insensitive";
    }
  | null
  | undefined;

/**
 * Where input type for table queries supporting AND, OR, and NOT operators.
 */
type WhereInput<TTable> = {
  [K in keyof TTable]?: WhereValue<TTable[K]>;
} & {
  AND?: WhereInput<TTable> | WhereInput<TTable>[];
  OR?: WhereInput<TTable>[];
  NOT?: WhereInput<TTable> | WhereInput<TTable>[];
};

// Helper to create where input with id - properly typed
// Returns a value that satisfies WhereInput<T> when T has an 'id' property
function createWhereInputById<
  T extends Record<string, DatabaseValue | JsonValue>,
>(
  id: string,
): { id: string } & Partial<
  Record<Exclude<keyof T, "id">, WhereValue<T[Exclude<keyof T, "id">]>>
> {
  return { id } as { id: string } & Partial<
    Record<Exclude<keyof T, "id">, WhereValue<T[Exclude<keyof T, "id">]>>
  >;
}

/**
 * Order by input type for sorting query results.
 */
type OrderByInput<TTable> = {
  [K in keyof TTable]?: "asc" | "desc";
};

/**
 * Include input type for loading relations in queries.
 */
type IncludeInput = Record<
  string,
  | boolean
  | {
      select?: Record<string, boolean>;
      include?: IncludeInput;
      where?: Record<string, SQLValue | WhereValue<SQLValue>>;
      take?: number;
      orderBy?: Record<string, "asc" | "desc">;
    }
>;

/**
 * Select input type for specifying which fields to return.
 */
type SelectInput = Record<string, boolean>;

/**
 * Options for find operations including filtering, sorting, pagination, and relations.
 */
interface FindOptions<TSelect> {
  where?: WhereInput<TSelect>;
  orderBy?: OrderByInput<TSelect> | OrderByInput<TSelect>[];
  take?: number;
  skip?: number;
  include?: IncludeInput;
  select?: SelectInput;
}

/**
 * Extended type that includes relation data when include is specified in queries.
 */
export type WithRelations<T> = T &
  Record<string, SQLValue | Record<string, SQLValue>>;

/**
 * Options for create operations including data and optional relation loading.
 */
interface CreateOptions<TInsert> {
  data: TInsert;
  select?: SelectInput;
  include?: IncludeInput;
}

/**
 * Update data type supporting direct values and increment/decrement operations for numeric fields.
 */
type UpdateData<TInsert> = {
  [K in keyof TInsert]?:
    | TInsert[K]
    | { increment: number }
    | { decrement: number };
};

interface UpdateOptions<TSelect, TInsert> {
  where: WhereInput<TSelect>;
  data: UpdateData<TInsert>;
  select?: SelectInput;
  include?: IncludeInput;
}

/**
 * Options for delete operations including where clause and optional field selection.
 */
interface DeleteOptions<TSelect> {
  where: WhereInput<TSelect>;
  select?: SelectInput;
}

/**
 * Options for upsert operations (create or update).
 */
interface UpsertOptions<TSelect, TInsert> {
  where: WhereInput<TSelect>;
  create: TInsert;
  update: Partial<TInsert>;
  include?: IncludeInput;
}

/**
 * Build a Drizzle SQL where clause from a where input object.
 */
function buildWhereClause<
  TTable extends PgTable,
  TWhere extends Record<string, DatabaseValue | JsonValue>,
>(table: TTable, where: WhereInput<TWhere> | undefined): SQL | undefined {
  if (!where) return undefined;

  const conditions: SQL[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (key === "AND") {
      const andConditions = Array.isArray(value) ? value : [value];
      const andClauses = andConditions
        .map((w) =>
          buildWhereClause(
            table,
            w as WhereInput<Record<string, DatabaseValue | JsonValue>>,
          ),
        )
        .filter((c): c is SQL => c !== undefined);
      if (andClauses.length > 0) {
        conditions.push(and(...andClauses)!);
      }
      continue;
    }

    if (key === "OR") {
      const orConditions = value as WhereInput<
        Record<string, DatabaseValue | JsonValue>
      >[];
      const orClauses = orConditions
        .map((w) => buildWhereClause(table, w))
        .filter((c): c is SQL => c !== undefined);
      if (orClauses.length > 0) {
        conditions.push(or(...orClauses)!);
      }
      continue;
    }

    if (key === "NOT") {
      const notCondition = buildWhereClause(
        table,
        value as WhereInput<Record<string, DatabaseValue | JsonValue>>,
      );
      if (notCondition) {
        conditions.push(sql`NOT (${notCondition})`);
      }
      continue;
    }

    const tableConfig = getTableConfig(table);
    const column = findColumnByName(tableConfig, key);
    if (!column) continue;

    if (value === null) {
      conditions.push(isNull(column));
      continue;
    }

    if (value === undefined) continue;

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const ops = value as Record<string, DatabaseValue>;

      if ("equals" in ops) {
        if (ops.equals === null) {
          conditions.push(isNull(column));
        } else {
          conditions.push(eq(column, ops.equals));
        }
      }
      if ("not" in ops) {
        if (ops.not === null) {
          conditions.push(isNotNull(column));
        } else if (
          typeof ops.not === "object" &&
          ops.not !== null &&
          "equals" in ops.not
        ) {
          const notEqualsValue = (ops.not as { equals: DatabaseValue }).equals;
          conditions.push(ne(column, notEqualsValue));
        } else {
          conditions.push(ne(column, ops.not));
        }
      }
      if ("in" in ops && Array.isArray(ops.in)) {
        conditions.push(inArray(column, ops.in));
      }
      if ("notIn" in ops && Array.isArray(ops.notIn)) {
        conditions.push(notInArray(column, ops.notIn));
      }
      if ("lt" in ops) conditions.push(lt(column, ops.lt));
      if ("lte" in ops) conditions.push(lte(column, ops.lte));
      if ("gt" in ops) conditions.push(gt(column, ops.gt));
      if ("gte" in ops) conditions.push(gte(column, ops.gte));
      if ("contains" in ops) {
        const mode = (ops as { mode?: string }).mode;
        if (mode === "insensitive") {
          conditions.push(ilike(column, `%${ops.contains}%`));
        } else {
          conditions.push(like(column, `%${ops.contains}%`));
        }
      }
      if ("startsWith" in ops) {
        const mode = (ops as { mode?: string }).mode;
        if (mode === "insensitive") {
          conditions.push(ilike(column, `${ops.startsWith}%`));
        } else {
          conditions.push(like(column, `${ops.startsWith}%`));
        }
      }
      if ("endsWith" in ops) {
        const mode = (ops as { mode?: string }).mode;
        if (mode === "insensitive") {
          conditions.push(ilike(column, `%${ops.endsWith}`));
        } else {
          conditions.push(like(column, `%${ops.endsWith}`));
        }
      }
    } else {
      conditions.push(eq(column, value));
    }
  }

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return and(...conditions);
}

/**
 * Build Drizzle SQL order by clauses from an order by input object.
 */
function buildOrderBy<TTable extends PgTable>(
  table: TTable,
  orderBy:
    | OrderByInput<Record<string, DatabaseValue>>
    | OrderByInput<Record<string, DatabaseValue>>[]
    | undefined,
): SQL[] {
  if (!orderBy) return [];

  const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
  const result: SQL[] = [];

  const tableConfig = getTableConfig(table);
  for (const order of orders) {
    for (const [key, direction] of Object.entries(order)) {
      const column = findColumnByName(tableConfig, key);
      if (column) {
        result.push(direction === "desc" ? desc(column) : asc(column));
      }
    }
  }

  return result;
}

/**
 * Type representing all valid database value types including JSON columns.
 *
 * JSONB columns with custom types (e.g., NpcMemory[], PriceModifier[]) use .$type<T>()
 * in schema definitions. These typed interfaces don't satisfy the strict JsonValue constraint
 * because they have narrower field types (e.g., literal unions instead of string).
 *
 * The `unknown` in this union is intentional and necessary to accept schema-inferred
 * custom JSONB types. This does NOT weaken type safety because:
 *
 * 1. **Repository generics preserve types**: TSelect and TInsert are inferred from
 *    InferSelect<TTable> and InferInsert<TTable>, which carry full type information
 * 2. **Public API remains typed**: Method signatures like findUnique() return TSelect,
 *    not DatabaseValue - callers always receive properly typed results
 * 3. **This union is internal only**: It only affects internal constraint checking
 *    on Record<string, DatabaseValue>, not the types exposed to consumers
 *
 * Without `unknown`, schema-defined types like `NpcMemory[]` and `PriceModifier[]`
 * would fail the constraint check, breaking TableRepository for those tables.
 *
 * @see NpcMemory, PriceModifier for examples of custom JSONB types
 * @see TableRepository for how types flow through the repository pattern
 */
type DatabaseValue =
  | SQLValue
  | { [key: string]: DatabaseValue }
  | DatabaseValue[]
  | JsonValue
  | JsonValue[]
  | unknown;

/**
 * Table repository providing ORM-style methods for database operations.
 * Supports findUnique, findMany, create, update, delete, and aggregate operations.
 *
 * Type parameters:
 * - TTable: The Drizzle table schema (e.g., typeof schema.users)
 * - TSelect: The inferred select type from the schema (use InferSelect<TTable>)
 * - TInsert: The inferred insert type from the schema (use InferInsert<TTable>)
 */
export class TableRepository<
  TTable extends PgTable,
  TSelect extends Record<string, DatabaseValue | JsonValue>,
  TInsert extends Record<string, DatabaseValue | JsonValue>,
> {
  private readonly queryAPI: RelationalQueryAPI | undefined;

  constructor(
    private readonly drizzle: SchemaDatabase,
    private readonly table: TTable,
    private readonly tableName: string,
  ) {
    this.queryAPI = this.drizzle.query;
  }

  /**
   * Build Drizzle relational query 'with' clause from include options.
   *
   * @param include - Include configuration for loading relations
   * @returns Drizzle-compatible 'with' clause configuration
   */
  private buildWithClause(
    include: IncludeInput,
  ): Record<string, boolean | RelationalQueryConfig> {
    const withClause: Record<string, boolean | RelationalQueryConfig> = {};
    for (const [key, value] of Object.entries(include)) {
      if (value === true) {
        withClause[key] = true;
      } else if (typeof value === "object" && value !== null) {
        const nested: RelationalQueryConfig = {};
        if (value.take) nested.limit = value.take;
        if (value.orderBy) {
          const orders: SQL[] = [];
          for (const [oKey, oDir] of Object.entries(value.orderBy)) {
            orders.push(
              oDir === "desc"
                ? sql`${sql.identifier(oKey)} DESC`
                : sql`${sql.identifier(oKey)} ASC`,
            );
          }
          if (orders.length > 0) nested.orderBy = orders;
        }
        if (value.include) nested.with = this.buildWithClause(value.include);
        if (value.select) {
          nested.with = {
            ...nested.with,
            ...Object.fromEntries(
              Object.entries(value.select).map(([k, v]) => [k, v === true]),
            ),
          };
        }
        withClause[key] = Object.keys(nested).length > 0 ? nested : true;
      }
    }
    return withClause;
  }

  /**
   * Find a unique record by primary key or unique constraint
   * Returns type with relation access when include is specified
   */
  async findUnique(options: FindOptions<TSelect>): Promise<TSelect | null> {
    const whereClause = buildWhereClause(this.table, options.where);

    // Use Drizzle's query API for relations if include is specified
    const relationalBuilder = getRelationalQueryBuilder(
      this.queryAPI,
      this.tableName,
    );
    if (options.include && relationalBuilder?.findFirst) {
      const result = await relationalBuilder.findFirst({
        where: whereClause,
        with: this.buildWithClause(options.include),
      });
      return result as TSelect | null;
    }

    // Use Drizzle's typed query builder - helper ensures type safety
    const results = await this.drizzle
      .select()
      .from(asDrizzleTable(this.table))
      .where(whereClause)
      .limit(1);

    return (results[0] as TSelect) || null;
  }

  /**
   * Find a unique record by primary key or unique constraint, throwing if not found
   */
  async findUniqueOrThrow(options: FindOptions<TSelect>): Promise<TSelect> {
    const result = await this.findUnique(options);
    if (!result) {
      throw new Error(`Record not found in ${this.tableName}`);
    }
    return result;
  }

  /**
   * Find the first record matching the criteria
   */
  async findFirst(options: FindOptions<TSelect> = {}): Promise<TSelect | null> {
    const whereClause = buildWhereClause(this.table, options.where);
    const orderByClause = buildOrderBy(this.table, options.orderBy);

    // Use Drizzle's query API for relations if include is specified
    const relationalBuilder = getRelationalQueryBuilder(
      this.queryAPI,
      this.tableName,
    );
    if (options.include && relationalBuilder?.findFirst) {
      const result = await relationalBuilder.findFirst({
        where: whereClause,
        with: this.buildWithClause(options.include),
        orderBy: orderByClause.length > 0 ? orderByClause : undefined,
      });
      return result as TSelect | null;
    }

    // Use Drizzle's typed query builder with $dynamic() for conditional chaining
    // Helper ensures type safety
    let query = this.drizzle
      .select()
      .from(asDrizzleTable(this.table))
      .$dynamic();
    if (whereClause) query = query.where(whereClause);
    if (orderByClause.length > 0) query = query.orderBy(...orderByClause);
    if (options.skip) query = query.offset(options.skip);

    const results = (await query.limit(1)) as TSelect[];
    return (results[0] as TSelect) || null;
  }

  /**
   * Find the first record matching the criteria, throwing if not found
   */
  async findFirstOrThrow(options: FindOptions<TSelect> = {}): Promise<TSelect> {
    const result = await this.findFirst(options);
    if (!result) {
      throw new Error(`Record not found in ${this.tableName}`);
    }
    return result;
  }

  /**
   * Find multiple records matching the criteria
   */
  async findMany(options: FindOptions<TSelect> = {}): Promise<TSelect[]> {
    const whereClause = buildWhereClause(this.table, options.where);
    const orderByClause = buildOrderBy(this.table, options.orderBy);

    // Use Drizzle's query API for relations if include is specified
    const relationalBuilder = getRelationalQueryBuilder(
      this.queryAPI,
      this.tableName,
    );
    if (options.include && relationalBuilder?.findMany) {
      const results = await relationalBuilder.findMany({
        where: whereClause,
        with: this.buildWithClause(options.include),
        orderBy: orderByClause.length > 0 ? orderByClause : undefined,
        limit: options.take,
        offset: options.skip,
      });
      return results as TSelect[];
    }

    // Use Drizzle's typed query builder with $dynamic() for conditional chaining
    // Helper ensures type safety
    let query = this.drizzle
      .select()
      .from(asDrizzleTable(this.table))
      .$dynamic();
    if (whereClause) query = query.where(whereClause);
    if (orderByClause.length > 0) query = query.orderBy(...orderByClause);
    if (options.take) query = query.limit(options.take);
    if (options.skip) query = query.offset(options.skip);

    const results = (await query) as TSelect[];
    return results;
  }

  /**
   * Create a new record
   */
  async create(options: CreateOptions<TInsert>): Promise<TSelect> {
    // Use Drizzle's typed insert - values() accepts the insert type
    // TInsert extends Record<string, DatabaseValue | JsonValue> which is compatible with Drizzle's insert
    const results = await this.drizzle
      .insert(this.table)
      .values(
        options.data as TInsert & Record<string, DatabaseValue | JsonValue>,
      )
      .returning();

    const created = results[0] as TSelect;

    // If include is specified, refetch with relations
    if (options.include && created) {
      const createdObj = created as Record<string, DatabaseValue | JsonValue>;
      if (
        typeof createdObj === "object" &&
        createdObj !== null &&
        "id" in createdObj &&
        typeof createdObj.id === "string"
      ) {
        // Build proper where input - id is a key of TSelect
        // Helper function ensures type safety - result is compatible with WhereInput<TSelect>
        const whereInput = createWhereInputById<TSelect>(createdObj.id);
        const refetched = await this.findUnique({
          where: whereInput as WhereInput<TSelect>,
          include: options.include,
        });
        return refetched || created;
      }
    }

    return created;
  }

  /**
   * Create multiple records
   */
  async createMany(options: {
    data: TInsert[];
    skipDuplicates?: boolean;
  }): Promise<{ count: number }> {
    if (options.data.length === 0) return { count: 0 };

    // Use Drizzle's typed insert - values() accepts array of insert type
    const insertQuery = this.drizzle
      .insert(this.table)
      .values(
        options.data as (TInsert & Record<string, DatabaseValue | JsonValue>)[],
      );

    if (options.skipDuplicates) {
      await insertQuery.onConflictDoNothing();
    } else {
      await insertQuery;
    }

    return { count: options.data.length };
  }

  /**
   * Update a single record
   */
  async update(options: UpdateOptions<TSelect, TInsert>): Promise<TSelect> {
    const whereClause = buildWhereClause(this.table, options.where);
    if (!whereClause) throw new Error("Update requires a where clause");

    // Handle increment/decrement operations
    const data = { ...options.data } as Record<
      string,
      DatabaseValue | JsonValue
    >;
    const setData: Record<string, DatabaseValue | JsonValue> = {};

    const tableConfig = getTableConfig(this.table);
    for (const [key, value] of Object.entries(data)) {
      // Find column by name - columns is an array
      const column = findColumnByName(tableConfig, key);
      if (
        column &&
        typeof value === "object" &&
        value !== null &&
        !(value instanceof Date)
      ) {
        if ("increment" in value) {
          // Convert increment to SQL expression
          setData[key] =
            sql`${column} + ${(value as { increment: number }).increment}`;
        } else if ("decrement" in value) {
          // Convert decrement to SQL expression
          setData[key] =
            sql`${column} - ${(value as { decrement: number }).decrement}`;
        } else {
          setData[key] = value;
        }
      } else {
        setData[key] = value;
      }
    }

    // Use Drizzle's typed update - set() accepts the update data type
    // setData is Record<string, DatabaseValue | JsonValue> which is compatible with Drizzle's set
    const results = await this.drizzle
      .update(this.table)
      .set(
        setData as Partial<TInsert & Record<string, DatabaseValue | JsonValue>>,
      )
      .where(whereClause)
      .returning();

    const updated = results[0] as TSelect;

    // If include is specified, refetch with relations
    if (options.include && updated) {
      const updatedObj = updated as Record<string, DatabaseValue | JsonValue>;
      if (
        typeof updatedObj === "object" &&
        updatedObj !== null &&
        "id" in updatedObj &&
        typeof updatedObj.id === "string"
      ) {
        // Build proper where input - id is a key of TSelect
        // Helper function ensures type safety - result is compatible with WhereInput<TSelect>
        const whereInput = createWhereInputById<TSelect>(updatedObj.id);
        const refetched = await this.findUnique({
          where: whereInput as WhereInput<TSelect>,
          include: options.include,
        });
        return refetched || updated;
      }
    }

    return updated;
  }

  /**
   * Update multiple records
   */
  async updateMany(
    options: UpdateOptions<TSelect, TInsert>,
  ): Promise<{ count: number }> {
    const whereClause = buildWhereClause(this.table, options.where);

    // Use Drizzle's typed update with $dynamic() for conditional where clause
    let query = this.drizzle
      .update(this.table)
      .set(options.data as Partial<TInsert>)
      .$dynamic();
    if (whereClause) query = query.where(whereClause);

    const results = await query.returning();
    return { count: results.length };
  }

  /**
   * Delete a single record
   */
  async delete(options: DeleteOptions<TSelect>): Promise<TSelect> {
    const whereClause = buildWhereClause(this.table, options.where);
    if (!whereClause) throw new Error("Delete requires a where clause");

    // Use Drizzle's typed delete
    const results = await this.drizzle
      .delete(this.table)
      .where(whereClause)
      .returning();

    return results[0] as TSelect;
  }

  /**
   * Delete multiple records
   */
  async deleteMany(
    options: DeleteOptions<TSelect> = {} as DeleteOptions<TSelect>,
  ): Promise<{ count: number }> {
    const whereClause = buildWhereClause(this.table, options.where);

    // Use Drizzle's typed delete with $dynamic() for conditional where clause
    let query = this.drizzle.delete(this.table).$dynamic();
    if (whereClause) query = query.where(whereClause);

    const results = await query.returning();
    return { count: results.length };
  }

  /**
   * Upsert (create or update) a record
   */
  async upsert(options: UpsertOptions<TSelect, TInsert>): Promise<TSelect> {
    const whereClause = buildWhereClause(this.table, options.where);

    // Try to find existing record
    let existing: TSelect[] = [];
    if (whereClause) {
      // Use Drizzle's typed select - helper ensures type safety
      existing = (await this.drizzle
        .select()
        .from(asDrizzleTable(this.table))
        .where(whereClause)
        .limit(1)) as TSelect[];
    }

    if (existing.length > 0) {
      // Update existing record
      return this.update({
        where: options.where,
        data: options.update,
        include: options.include,
      });
    }
    // Create new record
    return this.create({
      data: options.create,
      include: options.include,
    });
  }

  /**
   * Count records matching the criteria
   */
  async count(options: { where?: WhereInput<TSelect> } = {}): Promise<number> {
    const whereClause = buildWhereClause(this.table, options.where);

    // Use Drizzle's typed select with $dynamic() for conditional where clause
    // Helper ensures type safety
    let query = this.drizzle
      .select({ count: drizzleCount() })
      .from(asDrizzleTable(this.table))
      .$dynamic();
    if (whereClause) query = query.where(whereClause);

    const result = await query;
    return Number(
      (result[0] as { count: number | string | bigint } | undefined)?.count ??
        0,
    );
  }

  /**
   * Aggregate functions
   */
  async aggregate(options: {
    where?: WhereInput<TSelect>;
    _count?: boolean | { _all?: boolean };
    _sum?: SelectInput;
    _avg?: SelectInput;
    _min?: SelectInput;
    _max?: SelectInput;
  }): Promise<{
    _count?: { _all: number } | number;
    _sum?: Record<string, number | null>;
    _avg?: Record<string, number | null>;
    _min?: Record<string, number | null>;
    _max?: Record<string, number | null>;
  }> {
    const whereClause = buildWhereClause(this.table, options.where);
    const result: {
      _count?: { _all: number } | number;
      _sum?: Record<string, number | null>;
      _avg?: Record<string, number | null>;
      _min?: Record<string, number | null>;
      _max?: Record<string, number | null>;
    } = {};

    if (options._count) {
      let query = this.drizzle
        .select({ count: drizzleCount() })
        .from(asDrizzleTable(this.table))
        .$dynamic();
      if (whereClause) query = query.where(whereClause);
      const countResult = await query;
      result._count = {
        _all: Number(
          (countResult[0] as { count: number | string | bigint } | undefined)
            ?.count ?? 0,
        ),
      };
    }

    if (options._sum) {
      const sumResult: Record<string, number | null> = {};
      const tableConfig = getTableConfig(this.table);
      for (const [key, shouldSum] of Object.entries(options._sum)) {
        if (shouldSum) {
          const column = findColumnByName(tableConfig, key);
          if (column) {
            let query = this.drizzle
              .select({ sum: sql<number>`SUM(${column})` })
              .from(asDrizzleTable(this.table))
              .$dynamic();
            if (whereClause) query = query.where(whereClause);
            const queryResult = await query;
            sumResult[key] =
              (queryResult[0] as { sum: number | null } | undefined)?.sum !==
              null
                ? Number((queryResult[0] as { sum: number | null }).sum)
                : null;
          }
        }
      }
      result._sum = sumResult;
    }

    if (options._avg) {
      const avgResult: Record<string, number | null> = {};
      const tableConfig = getTableConfig(this.table);
      for (const [key, shouldAvg] of Object.entries(options._avg)) {
        if (shouldAvg) {
          const column = findColumnByName(tableConfig, key);
          if (column) {
            let query = this.drizzle
              .select({ avg: sql<number>`AVG(${column})` })
              .from(asDrizzleTable(this.table))
              .$dynamic();
            if (whereClause) query = query.where(whereClause);
            const queryResult = await query;
            avgResult[key] =
              (queryResult[0] as { avg: number | null } | undefined)?.avg !==
              null
                ? Number((queryResult[0] as { avg: number | null }).avg)
                : null;
          }
        }
      }
      result._avg = avgResult;
    }

    if (options._min) {
      const minResult: Record<string, number | null> = {};
      const tableConfig = getTableConfig(this.table);
      for (const [key, shouldMin] of Object.entries(options._min)) {
        if (shouldMin) {
          const column = findColumnByName(tableConfig, key);
          if (column) {
            let query = this.drizzle
              .select({ min: sql<number>`MIN(${column})` })
              .from(asDrizzleTable(this.table))
              .$dynamic();
            if (whereClause) query = query.where(whereClause);
            const queryResult = await query;
            minResult[key] =
              (queryResult[0] as { min: number | null } | undefined)?.min !==
              null
                ? Number((queryResult[0] as { min: number | null }).min)
                : null;
          }
        }
      }
      result._min = minResult;
    }

    if (options._max) {
      const maxResult: Record<string, number | null> = {};
      const tableConfig = getTableConfig(this.table);
      for (const [key, shouldMax] of Object.entries(options._max)) {
        if (shouldMax) {
          const column = findColumnByName(tableConfig, key);
          if (column) {
            let query = this.drizzle
              .select({ max: sql<number>`MAX(${column})` })
              .from(asDrizzleTable(this.table))
              .$dynamic();
            if (whereClause) query = query.where(whereClause);
            const queryResult = await query;
            maxResult[key] =
              (queryResult[0] as { max: number | null } | undefined)?.max !==
              null
                ? Number((queryResult[0] as { max: number | null }).max)
                : null;
          }
        }
      }
      result._max = maxResult;
    }

    return result;
  }

  /**
   * Group records by specified fields and perform aggregations.
   *
   * @param options - Group by options including fields, aggregations, and ordering
   * @returns Array of grouped results with aggregations
   */
  async groupBy<TKey extends keyof TSelect>(options: {
    by: TKey[];
    where?: WhereInput<TSelect>;
    _count?: SelectInput | boolean;
    _sum?: SelectInput;
    _avg?: SelectInput;
    _min?: SelectInput;
    _max?: SelectInput;
    orderBy?: OrderByInput<TSelect>;
    take?: number;
  }): Promise<Array<Record<string, DatabaseValue | JsonValue>>> {
    const whereClause = buildWhereClause(this.table, options.where);

    const selectFields: Record<string, PgColumn | SQL> = {};
    let countKey: string | null = null;

    const tableConfig = getTableConfig(this.table);
    for (const key of options.by) {
      const column = findColumnByName(tableConfig, key as string);
      if (column) {
        selectFields[key as string] = column;
      }
    }

    let simpleCount = false;

    if (options._count) {
      if (typeof options._count === "boolean" && options._count) {
        selectFields._countValue = drizzleCount();
        countKey = "_all";
        simpleCount = true;
      } else if (typeof options._count === "object") {
        const keys = Object.keys(options._count);
        if (keys.length > 0) {
          countKey = keys[0] ?? null;
          selectFields._countValue = drizzleCount();
        }
      }
    }

    const groupByColumns: PgColumn[] = [];
    for (const key of options.by) {
      const column = findColumnByName(tableConfig, key as string);
      if (column) {
        groupByColumns.push(column);
      }
    }

    let query = this.drizzle
      .select(selectFields as SelectedFields)
      .from(asDrizzleTable(this.table))
      .$dynamic();
    if (whereClause) query = query.where(whereClause);
    if (groupByColumns.length > 0) query = query.groupBy(...groupByColumns);

    const orderByClause = buildOrderBy(this.table, options.orderBy);
    if (orderByClause.length > 0) query = query.orderBy(...orderByClause);

    if (options.take) query = query.limit(options.take);

    const results = await query;

    return (results as Array<Record<string, DatabaseValue | JsonValue>>).map(
      (row) => {
        const transformed: Record<string, DatabaseValue | JsonValue> = {};
        for (const [key, value] of Object.entries(row)) {
          if (key === "_countValue" && countKey) {
            if (simpleCount) {
              transformed._count = Number(value);
            } else {
              transformed._count = { [countKey]: Number(value) };
            }
          } else {
            transformed[key] = value;
          }
        }
        return transformed;
      },
    );
  }
}

/**
 * Type helper to infer the select type from a Drizzle table.
 */
type InferSelect<T extends PgTable> = T["$inferSelect"];

/**
 * Type helper to infer the insert type from a Drizzle table.
 */
type InferInsert<T extends PgTable> = T["$inferInsert"];

/**
 * Drizzle database client interface providing ORM-style API and direct Drizzle access.
 * Includes table repositories for all database models and core Drizzle query methods.
 */
export interface DrizzleClient {
  /** Core Drizzle ORM query methods */
  select: SchemaDatabase["select"];
  selectDistinct: SchemaDatabase["selectDistinct"];
  selectDistinctOn: SchemaDatabase["selectDistinctOn"];
  insert: SchemaDatabase["insert"];
  update: SchemaDatabase["update"];
  delete: SchemaDatabase["delete"];
  execute: SchemaDatabase["execute"];
  transaction: SchemaDatabase["transaction"];
  query: SchemaDatabase["query"];

  /** Connection management methods */
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $transaction: <T>(callback: (tx: DrizzleClient) => Promise<T>) => Promise<T>;

  /** Raw SQL query methods using tagged template strings */
  $queryRaw: <T = Record<string, SQLValue>>(
    strings: TemplateStringsArray,
    ...values: SQLValue[]
  ) => Promise<T[]>;
  $executeRaw: (
    strings: TemplateStringsArray,
    ...values: SQLValue[]
  ) => Promise<number>;

  /** Table repositories for database models */
  user: TableRepository<
    typeof schema.users,
    InferSelect<typeof schema.users>,
    InferInsert<typeof schema.users>
  >;
  post: TableRepository<
    typeof schema.posts,
    InferSelect<typeof schema.posts>,
    InferInsert<typeof schema.posts>
  >;
  comment: TableRepository<
    typeof schema.comments,
    InferSelect<typeof schema.comments>,
    InferInsert<typeof schema.comments>
  >;
  reaction: TableRepository<
    typeof schema.reactions,
    InferSelect<typeof schema.reactions>,
    InferInsert<typeof schema.reactions>
  >;
  share: TableRepository<
    typeof schema.shares,
    InferSelect<typeof schema.shares>,
    InferInsert<typeof schema.shares>
  >;
  market: TableRepository<
    typeof schema.markets,
    InferSelect<typeof schema.markets>,
    InferInsert<typeof schema.markets>
  >;
  position: TableRepository<
    typeof schema.positions,
    InferSelect<typeof schema.positions>,
    InferInsert<typeof schema.positions>
  >;
  perpPosition: TableRepository<
    typeof schema.perpPositions,
    InferSelect<typeof schema.perpPositions>,
    InferInsert<typeof schema.perpPositions>
  >;
  stockPrice: TableRepository<
    typeof schema.stockPrices,
    InferSelect<typeof schema.stockPrices>,
    InferInsert<typeof schema.stockPrices>
  >;
  question: TableRepository<
    typeof schema.questions,
    InferSelect<typeof schema.questions>,
    InferInsert<typeof schema.questions>
  >;
  predictionPriceHistory: TableRepository<
    typeof schema.predictionPriceHistories,
    InferSelect<typeof schema.predictionPriceHistories>,
    InferInsert<typeof schema.predictionPriceHistories>
  >;
  chat: TableRepository<
    typeof schema.chats,
    InferSelect<typeof schema.chats>,
    InferInsert<typeof schema.chats>
  >;
  chatParticipant: TableRepository<
    typeof schema.chatParticipants,
    InferSelect<typeof schema.chatParticipants>,
    InferInsert<typeof schema.chatParticipants>
  >;
  message: TableRepository<
    typeof schema.messages,
    InferSelect<typeof schema.messages>,
    InferInsert<typeof schema.messages>
  >;
  notification: TableRepository<
    typeof schema.notifications,
    InferSelect<typeof schema.notifications>,
    InferInsert<typeof schema.notifications>
  >;
  dmAcceptance: TableRepository<
    typeof schema.dmAcceptances,
    InferSelect<typeof schema.dmAcceptances>,
    InferInsert<typeof schema.dmAcceptances>
  >;
  userInteraction: TableRepository<
    typeof schema.userInteractions,
    InferSelect<typeof schema.userInteractions>,
    InferInsert<typeof schema.userInteractions>
  >;
  agentRegistry: TableRepository<
    typeof schema.agentRegistries,
    InferSelect<typeof schema.agentRegistries>,
    InferInsert<typeof schema.agentRegistries>
  >;
  agentCapability: TableRepository<
    typeof schema.agentCapabilities,
    InferSelect<typeof schema.agentCapabilities>,
    InferInsert<typeof schema.agentCapabilities>
  >;
  agentLog: TableRepository<
    typeof schema.agentLogs,
    InferSelect<typeof schema.agentLogs>,
    InferInsert<typeof schema.agentLogs>
  >;
  agentMessage: TableRepository<
    typeof schema.agentMessages,
    InferSelect<typeof schema.agentMessages>,
    InferInsert<typeof schema.agentMessages>
  >;
  agentPerformanceMetrics: TableRepository<
    typeof schema.agentPerformanceMetrics,
    InferSelect<typeof schema.agentPerformanceMetrics>,
    InferInsert<typeof schema.agentPerformanceMetrics>
  >;
  agentGoal: TableRepository<
    typeof schema.agentGoals,
    InferSelect<typeof schema.agentGoals>,
    InferInsert<typeof schema.agentGoals>
  >;
  agentGoalAction: TableRepository<
    typeof schema.agentGoalActions,
    InferSelect<typeof schema.agentGoalActions>,
    InferInsert<typeof schema.agentGoalActions>
  >;
  agentPointsTransaction: TableRepository<
    typeof schema.agentPointsTransactions,
    InferSelect<typeof schema.agentPointsTransactions>,
    InferInsert<typeof schema.agentPointsTransactions>
  >;
  agentTrade: TableRepository<
    typeof schema.agentTrades,
    InferSelect<typeof schema.agentTrades>,
    InferInsert<typeof schema.agentTrades>
  >;
  externalAgentConnection: TableRepository<
    typeof schema.externalAgentConnections,
    InferSelect<typeof schema.externalAgentConnections>,
    InferInsert<typeof schema.externalAgentConnections>
  >;
  tradingFee: TableRepository<
    typeof schema.tradingFees,
    InferSelect<typeof schema.tradingFees>,
    InferInsert<typeof schema.tradingFees>
  >;
  balanceTransaction: TableRepository<
    typeof schema.balanceTransactions,
    InferSelect<typeof schema.balanceTransactions>,
    InferInsert<typeof schema.balanceTransactions>
  >;
  pointsTransaction: TableRepository<
    typeof schema.pointsTransactions,
    InferSelect<typeof schema.pointsTransactions>,
    InferInsert<typeof schema.pointsTransactions>
  >;
  userActorFollow: TableRepository<
    typeof schema.userActorFollows,
    InferSelect<typeof schema.userActorFollows>,
    InferInsert<typeof schema.userActorFollows>
  >;
  userBlock: TableRepository<
    typeof schema.userBlocks,
    InferSelect<typeof schema.userBlocks>,
    InferInsert<typeof schema.userBlocks>
  >;
  userMute: TableRepository<
    typeof schema.userMutes,
    InferSelect<typeof schema.userMutes>,
    InferInsert<typeof schema.userMutes>
  >;
  report: TableRepository<
    typeof schema.reports,
    InferSelect<typeof schema.reports>,
    InferInsert<typeof schema.reports>
  >;
  twitterOAuthToken: TableRepository<
    typeof schema.twitterOAuthTokens,
    InferSelect<typeof schema.twitterOAuthTokens>,
    InferInsert<typeof schema.twitterOAuthTokens>
  >;
  onboardingIntent: TableRepository<
    typeof schema.onboardingIntents,
    InferSelect<typeof schema.onboardingIntents>,
    InferInsert<typeof schema.onboardingIntents>
  >;
  favorite: TableRepository<
    typeof schema.favorites,
    InferSelect<typeof schema.favorites>,
    InferInsert<typeof schema.favorites>
  >;
  follow: TableRepository<
    typeof schema.follows,
    InferSelect<typeof schema.follows>,
    InferInsert<typeof schema.follows>
  >;
  followStatus: TableRepository<
    typeof schema.followStatuses,
    InferSelect<typeof schema.followStatuses>,
    InferInsert<typeof schema.followStatuses>
  >;
  profileUpdateLog: TableRepository<
    typeof schema.profileUpdateLogs,
    InferSelect<typeof schema.profileUpdateLogs>,
    InferInsert<typeof schema.profileUpdateLogs>
  >;
  shareAction: TableRepository<
    typeof schema.shareActions,
    InferSelect<typeof schema.shareActions>,
    InferInsert<typeof schema.shareActions>
  >;
  tag: TableRepository<
    typeof schema.tags,
    InferSelect<typeof schema.tags>,
    InferInsert<typeof schema.tags>
  >;
  postTag: TableRepository<
    typeof schema.postTags,
    InferSelect<typeof schema.postTags>,
    InferInsert<typeof schema.postTags>
  >;
  trendingTag: TableRepository<
    typeof schema.trendingTags,
    InferSelect<typeof schema.trendingTags>,
    InferInsert<typeof schema.trendingTags>
  >;
  llmCallLog: TableRepository<
    typeof schema.llmCallLogs,
    InferSelect<typeof schema.llmCallLogs>,
    InferInsert<typeof schema.llmCallLogs>
  >;
  marketOutcome: TableRepository<
    typeof schema.marketOutcomes,
    InferSelect<typeof schema.marketOutcomes>,
    InferInsert<typeof schema.marketOutcomes>
  >;
  trainedModel: TableRepository<
    typeof schema.trainedModels,
    InferSelect<typeof schema.trainedModels>,
    InferInsert<typeof schema.trainedModels>
  >;
  trainingBatch: TableRepository<
    typeof schema.trainingBatches,
    InferSelect<typeof schema.trainingBatches>,
    InferInsert<typeof schema.trainingBatches>
  >;
  benchmarkResult: TableRepository<
    typeof schema.benchmarkResults,
    InferSelect<typeof schema.benchmarkResults>,
    InferInsert<typeof schema.benchmarkResults>
  >;
  trajectory: TableRepository<
    typeof schema.trajectories,
    InferSelect<typeof schema.trajectories>,
    InferInsert<typeof schema.trajectories>
  >;
  rewardJudgment: TableRepository<
    typeof schema.rewardJudgments,
    InferSelect<typeof schema.rewardJudgments>,
    InferInsert<typeof schema.rewardJudgments>
  >;
  oracleCommitment: TableRepository<
    typeof schema.oracleCommitments,
    InferSelect<typeof schema.oracleCommitments>,
    InferInsert<typeof schema.oracleCommitments>
  >;
  oracleTransaction: TableRepository<
    typeof schema.oracleTransactions,
    InferSelect<typeof schema.oracleTransactions>,
    InferInsert<typeof schema.oracleTransactions>
  >;
  realtimeOutbox: TableRepository<
    typeof schema.realtimeOutboxes,
    InferSelect<typeof schema.realtimeOutboxes>,
    InferInsert<typeof schema.realtimeOutboxes>
  >;
  game: TableRepository<
    typeof schema.games,
    InferSelect<typeof schema.games>,
    InferInsert<typeof schema.games>
  >;
  gameConfig: TableRepository<
    typeof schema.gameConfigs,
    InferSelect<typeof schema.gameConfigs>,
    InferInsert<typeof schema.gameConfigs>
  >;
  oAuthState: TableRepository<
    typeof schema.oAuthStates,
    InferSelect<typeof schema.oAuthStates>,
    InferInsert<typeof schema.oAuthStates>
  >;
  systemSettings: TableRepository<
    typeof schema.systemSettings,
    InferSelect<typeof schema.systemSettings>,
    InferInsert<typeof schema.systemSettings>
  >;
  worldEvent: TableRepository<
    typeof schema.worldEvents,
    InferSelect<typeof schema.worldEvents>,
    InferInsert<typeof schema.worldEvents>
  >;
  worldFact: TableRepository<
    typeof schema.worldFacts,
    InferSelect<typeof schema.worldFacts>,
    InferInsert<typeof schema.worldFacts>
  >;
  rssFeedSource: TableRepository<
    typeof schema.rssFeedSources,
    InferSelect<typeof schema.rssFeedSources>,
    InferInsert<typeof schema.rssFeedSources>
  >;
  rssHeadline: TableRepository<
    typeof schema.rssHeadlines,
    InferSelect<typeof schema.rssHeadlines>,
    InferInsert<typeof schema.rssHeadlines>
  >;
  parodyHeadline: TableRepository<
    typeof schema.parodyHeadlines,
    InferSelect<typeof schema.parodyHeadlines>,
    InferInsert<typeof schema.parodyHeadlines>
  >;
  moderationEscrow: TableRepository<
    typeof schema.moderationEscrows,
    InferSelect<typeof schema.moderationEscrows>,
    InferInsert<typeof schema.moderationEscrows>
  >;
  generationLock: TableRepository<
    typeof schema.generationLocks,
    InferSelect<typeof schema.generationLocks>,
    InferInsert<typeof schema.generationLocks>
  >;
  feedback: TableRepository<
    typeof schema.feedbacks,
    InferSelect<typeof schema.feedbacks>,
    InferInsert<typeof schema.feedbacks>
  >;
  referral: TableRepository<
    typeof schema.referrals,
    InferSelect<typeof schema.referrals>,
    InferInsert<typeof schema.referrals>
  >;
  widgetCache: TableRepository<
    typeof schema.widgetCaches,
    InferSelect<typeof schema.widgetCaches>,
    InferInsert<typeof schema.widgetCaches>
  >;
  userAgentConfig: TableRepository<
    typeof schema.userAgentConfigs,
    InferSelect<typeof schema.userAgentConfigs>,
    InferInsert<typeof schema.userAgentConfigs>
  >;
  userApiKey: TableRepository<
    typeof schema.userApiKeys,
    InferSelect<typeof schema.userApiKeys>,
    InferInsert<typeof schema.userApiKeys>
  >;
  adminRole: TableRepository<
    typeof schema.adminRoles,
    InferSelect<typeof schema.adminRoles>,
    InferInsert<typeof schema.adminRoles>
  >;
  tickTokenStats: TableRepository<
    typeof schema.tickTokenStats,
    InferSelect<typeof schema.tickTokenStats>,
    InferInsert<typeof schema.tickTokenStats>
  >;
  questionArcPlan: TableRepository<
    typeof schema.questionArcPlans,
    InferSelect<typeof schema.questionArcPlans>,
    InferInsert<typeof schema.questionArcPlans>
  >;

  // Group system
  group: TableRepository<
    typeof schema.groups,
    InferSelect<typeof schema.groups>,
    InferInsert<typeof schema.groups>
  >;
  groupMember: TableRepository<
    typeof schema.groupMembers,
    InferSelect<typeof schema.groupMembers>,
    InferInsert<typeof schema.groupMembers>
  >;
  groupInvite: TableRepository<
    typeof schema.groupInvites,
    InferSelect<typeof schema.groupInvites>,
    InferInsert<typeof schema.groupInvites>
  >;
}

/**
 * Create a Drizzle client instance with table repositories and query methods.
 *
 * @param drizzle - Drizzle database instance
 * @returns Configured DrizzleClient with all table repositories
 */
export function createDrizzleClient(drizzle: SchemaDatabase): DrizzleClient {
  const $connect = async (): Promise<void> => {
    // No-op - Drizzle handles connections automatically
  };

  const $disconnect = async (): Promise<void> => {
    type PostgresClient = ReturnType<typeof postgres>;
    const globalForDb = globalThis as typeof globalThis & {
      postgresClient: PostgresClient | undefined;
      drizzleDb: SchemaDatabase | undefined;
      db: DrizzleClient | undefined;
    };

    if (globalForDb.postgresClient) {
      await globalForDb.postgresClient.end();
      globalForDb.postgresClient = undefined;
    }

    globalForDb.drizzleDb = undefined;
    globalForDb.db = undefined;
  };

  const $transaction = async <T>(
    callback: (tx: DrizzleClient) => Promise<T>,
  ): Promise<T> => {
    return drizzle.transaction(async (tx) => {
      const txClient = createDrizzleClient(tx as SchemaDatabase);
      return callback(txClient);
    });
  };

  const $queryRaw = async <T = Record<string, SQLValue>>(
    strings: TemplateStringsArray,
    ...values: SQLValue[]
  ): Promise<T[]> => {
    const query = sql(strings, ...values);
    const result = await drizzle.execute(query);
    return Array.from(result) as T[];
  };

  const $executeRaw = async (
    strings: TemplateStringsArray,
    ...values: SQLValue[]
  ): Promise<number> => {
    const query = sql(strings, ...values);
    await drizzle.execute(query);
    return 1;
  };

  return {
    // Core Drizzle methods
    select: drizzle.select.bind(drizzle),
    selectDistinct: drizzle.selectDistinct.bind(drizzle),
    selectDistinctOn: drizzle.selectDistinctOn.bind(drizzle),
    insert: drizzle.insert.bind(drizzle),
    update: drizzle.update.bind(drizzle),
    delete: drizzle.delete.bind(drizzle),
    execute: drizzle.execute.bind(drizzle),
    transaction: drizzle.transaction.bind(drizzle),
    query: drizzle.query,

    // Connection management
    $connect,
    $disconnect,
    $transaction,
    $queryRaw,
    $executeRaw,

    // Model repositories
    user: new TableRepository(drizzle, schema.users, "users"),
    post: new TableRepository(drizzle, schema.posts, "posts"),
    comment: new TableRepository(drizzle, schema.comments, "comments"),
    reaction: new TableRepository(drizzle, schema.reactions, "reactions"),
    share: new TableRepository(drizzle, schema.shares, "shares"),
    market: new TableRepository(drizzle, schema.markets, "markets"),
    position: new TableRepository(drizzle, schema.positions, "positions"),
    perpPosition: new TableRepository(
      drizzle,
      schema.perpPositions,
      "perpPositions",
    ),
    stockPrice: new TableRepository(drizzle, schema.stockPrices, "stockPrices"),
    question: new TableRepository(drizzle, schema.questions, "questions"),
    predictionPriceHistory: new TableRepository(
      drizzle,
      schema.predictionPriceHistories,
      "predictionPriceHistories",
    ),
    chat: new TableRepository(drizzle, schema.chats, "chats"),
    chatParticipant: new TableRepository(
      drizzle,
      schema.chatParticipants,
      "chatParticipants",
    ),
    message: new TableRepository(drizzle, schema.messages, "messages"),
    notification: new TableRepository(
      drizzle,
      schema.notifications,
      "notifications",
    ),
    dmAcceptance: new TableRepository(
      drizzle,
      schema.dmAcceptances,
      "dmAcceptances",
    ),
    userInteraction: new TableRepository(
      drizzle,
      schema.userInteractions,
      "userInteractions",
    ),
    agentRegistry: new TableRepository(
      drizzle,
      schema.agentRegistries,
      "agentRegistries",
    ),
    agentCapability: new TableRepository(
      drizzle,
      schema.agentCapabilities,
      "agentCapabilities",
    ),
    agentLog: new TableRepository(drizzle, schema.agentLogs, "agentLogs"),
    agentMessage: new TableRepository(
      drizzle,
      schema.agentMessages,
      "agentMessages",
    ),
    agentPerformanceMetrics: new TableRepository(
      drizzle,
      schema.agentPerformanceMetrics,
      "agentPerformanceMetrics",
    ),
    agentGoal: new TableRepository(drizzle, schema.agentGoals, "agentGoals"),
    agentGoalAction: new TableRepository(
      drizzle,
      schema.agentGoalActions,
      "agentGoalActions",
    ),
    agentPointsTransaction: new TableRepository(
      drizzle,
      schema.agentPointsTransactions,
      "agentPointsTransactions",
    ),
    agentTrade: new TableRepository(drizzle, schema.agentTrades, "agentTrades"),
    externalAgentConnection: new TableRepository(
      drizzle,
      schema.externalAgentConnections,
      "externalAgentConnections",
    ),
    tradingFee: new TableRepository(drizzle, schema.tradingFees, "tradingFees"),
    balanceTransaction: new TableRepository(
      drizzle,
      schema.balanceTransactions,
      "balanceTransactions",
    ),
    pointsTransaction: new TableRepository(
      drizzle,
      schema.pointsTransactions,
      "pointsTransactions",
    ),
    userActorFollow: new TableRepository(
      drizzle,
      schema.userActorFollows,
      "userActorFollows",
    ),
    userBlock: new TableRepository(drizzle, schema.userBlocks, "userBlocks"),
    userMute: new TableRepository(drizzle, schema.userMutes, "userMutes"),
    report: new TableRepository(drizzle, schema.reports, "reports"),
    twitterOAuthToken: new TableRepository(
      drizzle,
      schema.twitterOAuthTokens,
      "twitterOAuthTokens",
    ),
    onboardingIntent: new TableRepository(
      drizzle,
      schema.onboardingIntents,
      "onboardingIntents",
    ),
    favorite: new TableRepository(drizzle, schema.favorites, "favorites"),
    follow: new TableRepository(drizzle, schema.follows, "follows"),
    followStatus: new TableRepository(
      drizzle,
      schema.followStatuses,
      "followStatuses",
    ),
    profileUpdateLog: new TableRepository(
      drizzle,
      schema.profileUpdateLogs,
      "profileUpdateLogs",
    ),
    shareAction: new TableRepository(
      drizzle,
      schema.shareActions,
      "shareActions",
    ),
    tag: new TableRepository(drizzle, schema.tags, "tags"),
    postTag: new TableRepository(drizzle, schema.postTags, "postTags"),
    trendingTag: new TableRepository(
      drizzle,
      schema.trendingTags,
      "trendingTags",
    ),
    llmCallLog: new TableRepository(drizzle, schema.llmCallLogs, "llmCallLogs"),
    marketOutcome: new TableRepository(
      drizzle,
      schema.marketOutcomes,
      "marketOutcomes",
    ),
    trainedModel: new TableRepository(
      drizzle,
      schema.trainedModels,
      "trainedModels",
    ),
    trainingBatch: new TableRepository(
      drizzle,
      schema.trainingBatches,
      "trainingBatches",
    ),
    benchmarkResult: new TableRepository(
      drizzle,
      schema.benchmarkResults,
      "benchmarkResults",
    ),
    trajectory: new TableRepository(
      drizzle,
      schema.trajectories,
      "trajectories",
    ),
    rewardJudgment: new TableRepository(
      drizzle,
      schema.rewardJudgments,
      "rewardJudgments",
    ),
    oracleCommitment: new TableRepository(
      drizzle,
      schema.oracleCommitments,
      "oracleCommitments",
    ),
    oracleTransaction: new TableRepository(
      drizzle,
      schema.oracleTransactions,
      "oracleTransactions",
    ),
    realtimeOutbox: new TableRepository(
      drizzle,
      schema.realtimeOutboxes,
      "realtimeOutboxes",
    ),
    game: new TableRepository(drizzle, schema.games, "games"),
    gameConfig: new TableRepository(drizzle, schema.gameConfigs, "gameConfigs"),
    oAuthState: new TableRepository(drizzle, schema.oAuthStates, "oAuthStates"),
    systemSettings: new TableRepository(
      drizzle,
      schema.systemSettings,
      "systemSettings",
    ),
    worldEvent: new TableRepository(drizzle, schema.worldEvents, "worldEvents"),
    worldFact: new TableRepository(drizzle, schema.worldFacts, "worldFacts"),
    rssFeedSource: new TableRepository(
      drizzle,
      schema.rssFeedSources,
      "rssFeedSources",
    ),
    rssHeadline: new TableRepository(
      drizzle,
      schema.rssHeadlines,
      "rssHeadlines",
    ),
    parodyHeadline: new TableRepository(
      drizzle,
      schema.parodyHeadlines,
      "parodyHeadlines",
    ),
    moderationEscrow: new TableRepository(
      drizzle,
      schema.moderationEscrows,
      "moderationEscrows",
    ),
    generationLock: new TableRepository(
      drizzle,
      schema.generationLocks,
      "generationLocks",
    ),
    feedback: new TableRepository(drizzle, schema.feedbacks, "feedbacks"),
    referral: new TableRepository(drizzle, schema.referrals, "referrals"),
    widgetCache: new TableRepository(
      drizzle,
      schema.widgetCaches,
      "widgetCaches",
    ),
    userAgentConfig: new TableRepository(
      drizzle,
      schema.userAgentConfigs,
      "userAgentConfigs",
    ),
    userApiKey: new TableRepository(drizzle, schema.userApiKeys, "userApiKeys"),
    adminRole: new TableRepository(drizzle, schema.adminRoles, "adminRoles"),
    tickTokenStats: new TableRepository(
      drizzle,
      schema.tickTokenStats,
      "tickTokenStats",
    ),
    questionArcPlan: new TableRepository(
      drizzle,
      schema.questionArcPlans,
      "questionArcPlans",
    ),

    // Group system
    group: new TableRepository(drizzle, schema.groups, "groups"),
    groupMember: new TableRepository(
      drizzle,
      schema.groupMembers,
      "groupMembers",
    ),
    groupInvite: new TableRepository(
      drizzle,
      schema.groupInvites,
      "groupInvites",
    ),
  };
}
