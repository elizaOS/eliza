import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the cache table.
 * Has a composite primary key on (key, agent_id).
 */
export const cacheSchema: SchemaTable = {
	name: "cache",
	schema: "",
	columns: {
		key: {
			name: "key",
			type: "text",
			notNull: true,
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		value: {
			name: "value",
			type: "jsonb",
			notNull: true,
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		expires_at: {
			name: "expires_at",
			type: "timestamp",
		},
	},
	indexes: {},
	foreignKeys: {
		fk_cache_agent: {
			name: "fk_cache_agent",
			tableFrom: "cache",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {
		cache_pk: {
			name: "cache_pk",
			columns: ["key", "agent_id"],
		},
	},
	uniqueConstraints: {},
	checkConstraints: {},
};
