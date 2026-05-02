import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the message_servers table.
 */
export const messageServerSchema: SchemaTable = {
	name: "message_servers",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		},
		name: {
			name: "name",
			type: "text",
			notNull: true,
		},
		source_type: {
			name: "source_type",
			type: "text",
			notNull: true,
		},
		source_id: {
			name: "source_id",
			type: "text",
		},
		metadata: {
			name: "metadata",
			type: "jsonb",
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
	indexes: {
		// WHY: findOrCreateMessageServer searches by source_type + source_id
		// to locate existing servers. Without this index, the lookup scans
		// the entire table.
		idx_ms_source: {
			name: "idx_ms_source",
			columns: [
				{ expression: "source_type", isExpression: false },
				{ expression: "source_id", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
