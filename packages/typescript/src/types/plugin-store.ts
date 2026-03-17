import type { UUID } from "./primitives";

/**
 * Plugin Schema Registration and Store System
 *
 * WHY: Plugins need to store custom data (goals, todos, etc.) but shouldn't
 * cast runtime.db to Drizzle types. This creates tight coupling to SQL adapters
 * and prevents plugins from working with in-memory adapters.
 *
 * DESIGN: Provide a simple, generic CRUD interface that:
 * - Works across SQL and in-memory adapters
 * - Handles schema registration and migrations
 * - Supports common query patterns (equality, IN, limit/offset)
 * - Doesn't try to be a full ORM (no joins, subqueries, etc.)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Schema Definition Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column types supported by the plugin store
 *
 * WHY limited set: These map cleanly to PostgreSQL, MySQL, and in-memory storage.
 * Complex types (arrays, nested JSON) can be stored as JSONB.
 */
export type PluginColumnType =
	| "uuid"
	| "string"
	| "text"
	| "integer"
	| "boolean"
	| "timestamp"
	| "jsonb";

/**
 * Column definition for a plugin table
 */
export interface PluginColumn {
	name: string;
	type: PluginColumnType;
	primaryKey?: boolean;
	notNull?: boolean;
	default?: unknown;
	references?: {
		table: string;
		column: string;
		onDelete?: "cascade" | "set null" | "restrict";
	};
}

/**
 * Index definition for a plugin table
 */
export interface PluginIndex {
	name: string;
	columns: string[];
	unique?: boolean;
}

/**
 * Complete table schema for a plugin
 */
export interface PluginTableSchema {
	name: string;
	columns: PluginColumn[];
	indexes?: PluginIndex[];
}

/**
 * Full schema registration for a plugin
 *
 * WHY pluginName: Namespaces tables to avoid conflicts. Tables are prefixed
 * with plugin name (e.g., "goals_goals", "goals_goal_tags").
 */
export interface PluginSchema {
	pluginName: string;
	tables: PluginTableSchema[];
	version?: number; // For future migration support
}

// ─────────────────────────────────────────────────────────────────────────────
// Query Filter Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filter conditions for plugin store queries
 *
 * WHY limited operators: Start with the most common patterns. Can extend later
 * if plugins need more complex queries.
 *
 * Supported patterns:
 * - { id: "abc" } - equality
 * - { agentId: { $in: ["a", "b"] } } - IN clause
 * - { isCompleted: false, agentId: "xyz" } - AND combination
 */
export type PluginFilterValue =
	| string
	| number
	| boolean
	| null
	| { $in: (string | number | boolean)[] }
	| { $gt: number | Date }
	| { $lt: number | Date }
	| { $gte: number | Date }
	| { $lte: number | Date };

export type PluginFilter = Record<string, PluginFilterValue>;

/**
 * Sort direction
 */
export type PluginSortDirection = "asc" | "desc";

/**
 * Order by clause
 */
export interface PluginOrderBy {
	column: string;
	direction: PluginSortDirection;
}

/**
 * Query options
 */
export interface PluginQueryOptions {
	limit?: number;
	offset?: number;
	orderBy?: PluginOrderBy | PluginOrderBy[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin Store Interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generic CRUD interface for plugin data access
 *
 * WHY generic: Each plugin defines its own types. The store operates on
 * Record<string, unknown> and lets plugins cast to their types.
 *
 * USAGE:
 * ```typescript
 * const store = runtime.getPluginStore('goals');
 * const goals = await store.query<Goal>('goals', { agentId: runtime.agentId });
 * ```
 */
export interface IPluginStore {
	/**
	 * Query rows from a table
	 *
	 * @param table Table name (without plugin prefix)
	 * @param filter Filter conditions
	 * @param options Query options (limit, offset, orderBy)
	 * @returns Array of matching rows
	 */
	query<T = Record<string, unknown>>(
		table: string,
		filter?: PluginFilter,
		options?: PluginQueryOptions,
	): Promise<T[]>;

	/**
	 * Get a single row by ID
	 *
	 * @param table Table name (without plugin prefix)
	 * @param id Row ID
	 * @returns Row or null if not found
	 */
	getById<T = Record<string, unknown>>(
		table: string,
		id: UUID,
	): Promise<T | null>;

	/**
	 * Insert rows into a table
	 *
	 * WHY batch-first: Matches core adapter pattern. Plugins often need to
	 * insert multiple rows (e.g., goal + tags).
	 *
	 * @param table Table name (without plugin prefix)
	 * @param rows Array of rows to insert
	 * @returns Array of inserted row IDs (or empty array if no ID column)
	 */
	insert(table: string, rows: Record<string, unknown>[]): Promise<UUID[]>;

	/**
	 * Update rows in a table
	 *
	 * @param table Table name (without plugin prefix)
	 * @param filter Filter to match rows to update
	 * @param set Values to set
	 * @returns Number of rows updated
	 */
	update(
		table: string,
		filter: PluginFilter,
		set: Record<string, unknown>,
	): Promise<number>;

	/**
	 * Delete rows from a table
	 *
	 * @param table Table name (without plugin prefix)
	 * @param filter Filter to match rows to delete
	 * @returns Number of rows deleted
	 */
	delete(table: string, filter: PluginFilter): Promise<number>;

	/**
	 * Count rows in a table
	 *
	 * @param table Table name (without plugin prefix)
	 * @param filter Filter conditions
	 * @returns Number of matching rows
	 */
	count(table: string, filter?: PluginFilter): Promise<number>;
}
