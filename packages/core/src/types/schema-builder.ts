/**
 * DialectAdapter interface for schema builders.
 *
 * This type remains in core so plugins can import it without circular dependencies.
 * The actual implementations (pgAdapter, mysqlAdapter, buildTable) have moved to plugin-sql.
 */

import type { SchemaColumn, SchemaTable } from "./schema.ts";

/**
 * Contract that a dialect-specific adapter must implement.
 *
 * Currently Drizzle-shaped (createTable signature, .on() indexes).
 * That's intentional — Drizzle is the only ORM in use.  When a non-Drizzle
 * adapter is needed, evolve or replace this interface.
 */
export interface DialectAdapter {
	/** Wrap columns + an optional constraint/index factory into a table object. */
	createTable(
		name: string,
		columns: Record<string, unknown>,
		constraintsFn?: (table: Record<string, unknown>) => unknown[],
	): unknown;

	/** Map one abstract SchemaColumn to a concrete column builder. */
	buildColumn(col: SchemaColumn): unknown;

	/** Create an index builder that accepts column refs via .on(). */
	buildIndex(name: string): { on: (...cols: unknown[]) => unknown };

	/** Create a UNIQUE index builder. Falls back to buildIndex if not provided. */
	buildUniqueIndex?(name: string): { on: (...cols: unknown[]) => unknown };
}

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

/**
 * Build a table from an abstract schema using a dialect adapter.
 * The actual implementation has moved to plugin-sql, but the signature
 * is defined here for type safety.
 */
export type BuildTableFn = (
	schema: SchemaTable,
	adapter: DialectAdapter,
) => unknown;
