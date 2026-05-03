import type { SchemaTable } from "../../../types/schema.ts";

/**
 * Abstract schema definition for the long_term_memories table.
 *
 * This is the canonical, backend-agnostic description of the table structure.
 * Database adapters (Drizzle, Knex, raw SQL, etc.) translate this into their
 * own runtime representations.
 */
export const longTermMemories: SchemaTable = {
	name: "long_term_memories",
	schema: "public",
	columns: {
		id: { name: "id", type: "varchar(36)", primaryKey: true, notNull: true },
		agent_id: { name: "agent_id", type: "varchar(36)", notNull: true },
		entity_id: { name: "entity_id", type: "varchar(36)", notNull: true },
		category: { name: "category", type: "text", notNull: true },
		content: { name: "content", type: "text", notNull: true },
		metadata: { name: "metadata", type: "jsonb" },
		embedding: { name: "embedding", type: "real[]" },
		confidence: { name: "confidence", type: "real", default: 1.0 },
		source: { name: "source", type: "text" },
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
		last_accessed_at: { name: "last_accessed_at", type: "timestamp" },
		access_count: { name: "access_count", type: "integer", default: 0 },
	},
	indexes: {
		long_term_memories_agent_entity_idx: {
			name: "long_term_memories_agent_entity_idx",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "entity_id", isExpression: false },
			],
			isUnique: false,
		},
		long_term_memories_category_idx: {
			name: "long_term_memories_category_idx",
			columns: [{ expression: "category", isExpression: false }],
			isUnique: false,
		},
		long_term_memories_confidence_idx: {
			name: "long_term_memories_confidence_idx",
			columns: [{ expression: "confidence", isExpression: false }],
			isUnique: false,
		},
		long_term_memories_created_at_idx: {
			name: "long_term_memories_created_at_idx",
			columns: [{ expression: "created_at", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
