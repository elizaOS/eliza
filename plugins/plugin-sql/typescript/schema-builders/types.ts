/**
 * DialectAdapter interface and shared helpers for schema builders.
 *
 * A DialectAdapter maps abstract SchemaColumn / SchemaIndex definitions
 * to concrete ORM table objects.  Core ships a pg adapter; other dialects
 * are added by plugins when a real consumer exists.
 */
import type { SchemaColumn } from "@elizaos/core";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Contract that a dialect-specific adapter must implement.
 *
 * Currently Drizzle-shaped (createTable signature, .on() indexes).
 * That's intentional — Drizzle is the only ORM in use.  When a non-Drizzle
 * adapter is needed, evolve or replace this interface.
 */
export interface DialectAdapter {
  /** Wrap columns + an optional index/constraint factory into a table object. */
  createTable(
    name: string,
    columns: Record<string, any>,
    constraintsFn?: (table: any) => any[],
  ): any;

  /** Map one abstract SchemaColumn to a concrete column builder. */
  buildColumn(col: SchemaColumn): any;

  /** Create an index builder that accepts column refs via .on(). */
  buildIndex(name: string): { on: (...cols: any[]) => any };

  /** Create a UNIQUE index builder. Falls back to buildIndex if not provided. */
  buildUniqueIndex?(name: string): { on: (...cols: any[]) => any };

  /**
   * Create a unique constraint builder for table-level constraints.
   * For example: UNIQUE NULLS NOT DISTINCT (col1, col2)
   * Returns a constraint builder function that takes column refs.
   */
  buildUniqueConstraint?(name: string, nullsNotDistinct?: boolean): (columns: any[]) => any;

  /**
   * Create a foreign key constraint builder.
   * Returns a constraint builder function that takes source columns, target table, and target columns.
   */
  buildForeignKey?(
    name: string,
    onUpdate?: string,
    onDelete?: string,
  ): (columns: any[], targetTable: any, targetColumns: any[]) => any;

  /**
   * Create a check constraint builder.
   * Returns a constraint builder function that takes a SQL expression.
   */
  buildCheckConstraint?(name: string): (expr: any) => any;

  /**
   * Create an expression-based index (e.g., on SQL expressions like lower(email) or JSONB paths).
   * For GIN indexes on JSONB with operator class, pass method="gin" and opClass="jsonb_path_ops".
   */
  buildExpressionIndex?(
    name: string,
    expr: any,
    options?: { method?: string; opClass?: string; isUnique?: boolean },
  ): any;

  /**
   * Translate a raw SQL expression from canonical (PostgreSQL) syntax to the
   * dialect's native syntax. Called by buildTable() before wrapping in sql.raw().
   *
   * Handles dialect-specific differences in JSON operators, functions, etc.
   * If not implemented, expressions are passed through as-is (assumed PG-compatible).
   *
   * Translations performed by MySQL adapter:
   *   PG  col->>'key'   → MySQL  JSON_UNQUOTE(JSON_EXTRACT(col, '$.key'))
   *   PG  col->'key'    → MySQL  JSON_EXTRACT(col, '$.key')
   *   PG  col ? 'key'   → MySQL  JSON_CONTAINS_PATH(col, 'one', '$.key')
   */
  translateExpression?(expr: string): string;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Convert snake_case to camelCase.
 * Examples:
 *   "agent_id" → "agentId"
 *   "dim_384" → "dim384" (removes underscore before numbers)
 *   "created_at" → "createdAt"
 */
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}
