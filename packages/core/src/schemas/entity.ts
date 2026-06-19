import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the entities table.
 * Has a unique constraint on (id, agent_id).
 */
export const entitySchema: SchemaTable = {
	name: "entities",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		names: {
			name: "names",
			type: "text[]",
			notNull: true,
			default: "[]",
		},
		metadata: {
			name: "metadata",
			type: "jsonb",
			notNull: true,
			default: "{}",
		},
	},
	indexes: {
		// WHY: getEntitiesByIds and entity lookups filter by agent_id.
		// The unique constraint (id, agent_id) helps for exact matches,
		// but a plain index on agent_id alone is needed for "all entities
		// for this agent" scans used by getEntities, ensureEntityExists, etc.
		idx_entities_agent: {
			name: "idx_entities_agent",
			columns: [{ expression: "agent_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_entity_agent: {
			name: "fk_entity_agent",
			tableFrom: "entities",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		id_agent_id_unique: {
			name: "id_agent_id_unique",
			columns: ["id", "agent_id"],
		},
	},
	checkConstraints: {},
};
