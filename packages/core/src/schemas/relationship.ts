import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the relationships table.
 * Has unique constraint on (source_entity_id, target_entity_id, agent_id).
 */
export const relationshipSchema: SchemaTable = {
	name: "relationships",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		source_entity_id: {
			name: "source_entity_id",
			type: "uuid",
			notNull: true,
		},
		target_entity_id: {
			name: "target_entity_id",
			type: "uuid",
			notNull: true,
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
		tags: {
			name: "tags",
			type: "text[]",
		},
		metadata: {
			name: "metadata",
			type: "jsonb",
		},
	},
	indexes: {
		idx_relationships_users: {
			name: "idx_relationships_users",
			columns: [
				{ expression: "source_entity_id", isExpression: false },
				{ expression: "target_entity_id", isExpression: false },
			],
			isUnique: false,
		},
		// WHY: getRelationship queries use OR conditions that match either
		// source_entity_id or target_entity_id. The composite index above
		// covers source→target ordering, but target→source lookups need a
		// separate index for the OR branch to be efficiently indexed.
		idx_relationships_target: {
			name: "idx_relationships_target",
			columns: [{ expression: "target_entity_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_user_a: {
			name: "fk_user_a",
			tableFrom: "relationships",
			tableTo: "entities",
			columnsFrom: ["source_entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_user_b: {
			name: "fk_user_b",
			tableFrom: "relationships",
			tableTo: "entities",
			columnsFrom: ["target_entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_relationship_agent: {
			name: "fk_relationship_agent",
			tableFrom: "relationships",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {
		unique_relationship: {
			name: "unique_relationship",
			columns: ["source_entity_id", "target_entity_id", "agent_id"],
		},
	},
	checkConstraints: {},
};
