import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the worlds table.
 */
export const worldSchema: SchemaTable = {
	name: "worlds",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		name: {
			name: "name",
			type: "text",
			notNull: true,
		},
		metadata: {
			name: "metadata",
			type: "jsonb",
		},
		message_server_id: {
			name: "message_server_id",
			type: "uuid",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {
		// WHY: getWorldsByIds and getWorlds filter by agent_id.
		// Every world is agent-scoped; without this index, world
		// lookups require full table scans.
		idx_worlds_agent: {
			name: "idx_worlds_agent",
			columns: [{ expression: "agent_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_world_agent: {
			name: "fk_world_agent",
			tableFrom: "worlds",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
