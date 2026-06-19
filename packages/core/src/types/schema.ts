/**
 * Abstract, database-agnostic schema types.
 *
 * These types describe table structures as plain data objects, enabling any
 * database backend to interpret them without depending on a specific ORM.
 *
 * Promoted from the runtime-migrator's internal snapshot format so that core
 * can define canonical schemas that any adapter (Drizzle, Knex, raw SQL, etc.)
 * can consume.
 */

/** Column definition — describes a single column in a table. */
export interface SchemaColumn {
	name: string;
	type: string;
	primaryKey?: boolean;
	notNull?: boolean;
	default?: string | number | boolean;
	isUnique?: boolean;
	uniqueName?: string;
	uniqueType?: string;
}

/** Index column — a column (or expression) within an index. */
export interface IndexColumn {
	expression: string;
	isExpression: boolean;
	asc?: boolean;
	nulls?: string;
}

/** Index definition. */
export interface SchemaIndex {
	name: string;
	columns: IndexColumn[];
	isUnique: boolean;
	method?: string;
	where?: string;
	concurrently?: boolean;
}

/** Foreign key definition. */
export interface SchemaForeignKey {
	name: string;
	tableFrom: string;
	schemaFrom?: string;
	tableTo: string;
	schemaTo: string;
	columnsFrom: string[];
	columnsTo: string[];
	onDelete?: string;
	onUpdate?: string;
}

/** Composite primary key definition. */
export interface SchemaPrimaryKey {
	name: string;
	columns: string[];
}

/** Unique constraint definition. */
export interface SchemaUniqueConstraint {
	name: string;
	columns: string[];
	nullsNotDistinct?: boolean;
}

/** Check constraint definition. */
export interface SchemaCheckConstraint {
	name: string;
	value: string;
}

/** A complete table definition — the main unit of an abstract schema. */
export interface SchemaTable {
	name: string;
	schema: string;
	columns: Record<string, SchemaColumn>;
	indexes: Record<string, SchemaIndex>;
	foreignKeys: Record<string, SchemaForeignKey>;
	compositePrimaryKeys: Record<string, SchemaPrimaryKey>;
	uniqueConstraints: Record<string, SchemaUniqueConstraint>;
	checkConstraints: Record<string, SchemaCheckConstraint>;
}

/** Enum definition. */
export interface SchemaEnum {
	name: string;
	schema: string;
	values: string[];
}

/** Meta information for snapshot rename tracking. */
export interface SchemaMeta {
	schemas: Record<string, string>;
	tables: Record<string, string>;
	columns: Record<string, string>;
}

/** A full database snapshot — a collection of tables, schemas, and enums. */
export interface SchemaSnapshot {
	version: string;
	dialect: string;
	tables: Record<string, SchemaTable>;
	schemas: Record<string, string>;
	enums?: Record<string, SchemaEnum>;
	_meta: SchemaMeta;
	internal?: Record<string, unknown>;
}
