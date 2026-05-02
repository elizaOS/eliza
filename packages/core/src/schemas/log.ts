import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the logs table.
 */
export const logSchema: SchemaTable = {
	name: "logs",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			notNull: true,
			default: "defaultRandom()",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		entity_id: {
			name: "entity_id",
			type: "uuid",
			notNull: true,
		},
		body: {
			name: "body",
			type: "jsonb",
			notNull: true,
		},
		type: {
			name: "type",
			type: "text",
			notNull: true,
		},
		room_id: {
			name: "room_id",
			type: "uuid",
			notNull: true,
		},
	},
	indexes: {
		// WHY: getLogs filters by room_id + type and orders by created_at DESC.
		// This composite index covers the full query as a covering scan.
		idx_logs_room_type_created: {
			name: "idx_logs_room_type_created",
			columns: [
				{ expression: "room_id", isExpression: false },
				{ expression: "type", isExpression: false },
				{ expression: "created_at", isExpression: false },
			],
			isUnique: false,
		},
		// WHY: getLogs also filters by entity_id when provided.
		idx_logs_entity_type: {
			name: "idx_logs_entity_type",
			columns: [
				{ expression: "entity_id", isExpression: false },
				{ expression: "type", isExpression: false },
			],
			isUnique: false,
		},
		// WHY: getAgentRunSummaries queries logs by type alone to aggregate run
		// statistics (actions, thoughts, errors) across the whole agent.
		idx_logs_type: {
			name: "idx_logs_type",
			columns: [{ expression: "type", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_room: {
			name: "fk_room",
			tableFrom: "logs",
			tableTo: "rooms",
			columnsFrom: ["room_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_user: {
			name: "fk_user",
			tableFrom: "logs",
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
