import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the tasks table.
 */
export const taskSchema: SchemaTable = {
	name: "tasks",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "defaultRandom()",
		},
		name: {
			name: "name",
			type: "text",
			notNull: true,
		},
		description: {
			name: "description",
			type: "text",
		},
		room_id: {
			name: "room_id",
			type: "uuid",
		},
		world_id: {
			name: "world_id",
			type: "uuid",
		},
		entity_id: {
			name: "entity_id",
			type: "uuid",
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		tags: {
			name: "tags",
			type: "text[]",
			default: "[]",
		},
		metadata: {
			name: "metadata",
			type: "jsonb",
			default: "{}",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			default: "now()",
		},
		updated_at: {
			name: "updated_at",
			type: "timestamp",
			default: "now()",
		},
	},
	indexes: {
		// WHY: getTasks always filters by agent_id. This is the primary
		// scoping column since every task belongs to exactly one agent.
		idx_tasks_agent: {
			name: "idx_tasks_agent",
			columns: [{ expression: "agent_id", isExpression: false }],
			isUnique: false,
		},
		// WHY: getTasks filters by agent_id + name for named task lookups
		// (e.g., finding a specific scheduled task by name).
		idx_tasks_agent_name: {
			name: "idx_tasks_agent_name",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "name", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_task_agent: {
			name: "fk_task_agent",
			tableFrom: "tasks",
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
