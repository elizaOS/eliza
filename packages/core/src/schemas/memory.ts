import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the memories table.
 * Has expression-based indexes on JSON fields and check constraints for metadata validation.
 */
export const memorySchema: SchemaTable = {
	name: "memories",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		},
		type: {
			name: "type",
			type: "text",
			notNull: true,
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		content: {
			name: "content",
			type: "jsonb",
			notNull: true,
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
		room_id: {
			name: "room_id",
			type: "uuid",
		},
		world_id: {
			name: "world_id",
			type: "uuid",
		},
		unique: {
			name: "unique",
			type: "boolean",
			notNull: true,
			default: true,
		},
		metadata: {
			name: "metadata",
			type: "jsonb",
			notNull: true,
			default: "{}",
		},
	},
	indexes: {
		// WHY: Nearly every memory query filters on agent_id + type. This is the
		// primary access pattern for getMemories, searchMemoriesByEmbedding,
		// getMemoriesByRoomIds, getMemoryFragments, and deleteManyMemories.
		idx_memories_agent_type: {
			name: "idx_memories_agent_type",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "type", isExpression: false },
			],
			isUnique: false,
		},
		idx_memories_type_room: {
			name: "idx_memories_type_room",
			columns: [
				{ expression: "type", isExpression: false },
				{ expression: "room_id", isExpression: false },
			],
			isUnique: false,
		},
		// WHY: getMemoriesByWorldId JOINs memories→rooms and filters by entity_id.
		idx_memories_entity: {
			name: "idx_memories_entity",
			columns: [{ expression: "entity_id", isExpression: false }],
			isUnique: false,
		},
		idx_memories_world_id: {
			name: "idx_memories_world_id",
			columns: [{ expression: "world_id", isExpression: false }],
			isUnique: false,
		},
		idx_memories_metadata_type: {
			name: "idx_memories_metadata_type",
			columns: [{ expression: "((metadata->>'type'))", isExpression: true }],
			isUnique: false,
		},
		idx_memories_document_id: {
			name: "idx_memories_document_id",
			columns: [
				{ expression: "((metadata->>'documentId'))", isExpression: true },
			],
			isUnique: false,
		},
		idx_fragments_order: {
			name: "idx_fragments_order",
			columns: [
				{ expression: "((metadata->>'documentId'))", isExpression: true },
				{ expression: "((metadata->>'position'))", isExpression: true },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_room: {
			name: "fk_room",
			tableFrom: "memories",
			tableTo: "rooms",
			columnsFrom: ["room_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_user: {
			name: "fk_user",
			tableFrom: "memories",
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_agent: {
			name: "fk_agent",
			tableFrom: "memories",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {
		fragment_metadata_check: {
			name: "fragment_metadata_check",
			value: `
            CASE 
                WHEN metadata->>'type' = 'fragment' THEN
                    metadata ? 'documentId' AND 
                    metadata ? 'position'
                ELSE true
            END
        `,
		},
		document_metadata_check: {
			name: "document_metadata_check",
			value: `
            CASE 
                WHEN metadata->>'type' = 'document' THEN
                    metadata ? 'timestamp'
                ELSE true
            END
        `,
		},
	},
};
