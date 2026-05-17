import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the servers table.
 * Used for RLS multi-tenant isolation in multi-server deployments.
 */
export const serverSchema: SchemaTable = {
	name: "servers",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		updated_at: {
			name: "updated_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {},
	foreignKeys: {},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
