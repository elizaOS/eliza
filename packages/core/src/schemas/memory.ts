/**
 * Table descriptor for `memories` — the core store for everything an agent
 * remembers (messages, facts, documents and their fragments), typed by `type`
 * and scoped by agent/room/world. Metadata check constraints enforce the
 * document/fragment shape (fragments must carry documentId + position);
 * embedding vectors live in a separate 1:1 table. Portable `SchemaTable` shape
 * assembled by `buildBaseTables` and materialized by the plugin-sql / localdb
 * adapters.
 */

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
		idx_document_source_byte_seek: {
			name: "idx_document_source_byte_seek",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "((metadata->>'documentId'))", isExpression: true },
				{
					expression: "((metadata->>'documentRevision')::bigint)",
					isExpression: true,
				},
				{
					expression: "((metadata->>'revisionAttemptId'))",
					isExpression: true,
				},
				{
					expression: "((metadata->>'sourceByteEnd')::bigint)",
					isExpression: true,
				},
			],
			isUnique: false,
			where:
				"type = 'document_fragments' AND metadata->>'fragmentRole' = 'source-segment'",
		},
		idx_message_content_byte_seek: {
			name: "idx_message_content_byte_seek",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "((metadata->>'messageId'))", isExpression: true },
				{ expression: "((metadata->>'sourceKind'))", isExpression: true },
				{
					expression: "((metadata->>'attachmentIdHash'))",
					isExpression: true,
				},
				{
					expression: "((metadata->>'sourceRevision'))",
					isExpression: true,
				},
				{
					expression: "((metadata->>'byteEnd')::bigint)",
					isExpression: true,
				},
			],
			isUnique: false,
			where:
				"type = 'message_content_segments' AND metadata->>'type' = 'message-content-segment'",
		},
		idx_document_source_line_seek: {
			name: "idx_document_source_line_seek",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "((metadata->>'documentId'))", isExpression: true },
				{
					expression: "((metadata->>'documentRevision')::bigint)",
					isExpression: true,
				},
				{
					expression: "((metadata->>'revisionAttemptId'))",
					isExpression: true,
				},
				{
					expression: "((metadata->>'sourceLineEnd')::bigint)",
					isExpression: true,
				},
			],
			isUnique: false,
			where:
				"type = 'document_fragments' AND metadata->>'fragmentRole' = 'source-segment'",
		},
		idx_document_source_fragment_seek: {
			name: "idx_document_source_fragment_seek",
			columns: [
				{ expression: "agent_id", isExpression: false },
				{ expression: "((metadata->>'documentId'))", isExpression: true },
				{
					expression: "((metadata->>'documentRevision')::bigint)",
					isExpression: true,
				},
				{
					expression: "((metadata->>'revisionAttemptId'))",
					isExpression: true,
				},
				{
					expression: "((metadata->>'sourceFragmentEnd')::bigint)",
					isExpression: true,
				},
			],
			isUnique: false,
			where:
				"type = 'document_fragments' AND metadata->>'fragmentRole' = 'source-segment'",
		},
		idx_documents_pinned_created: {
			name: "idx_documents_pinned_created",
			columns: [
				{ expression: "created_at", isExpression: false },
				{ expression: "id", isExpression: false },
			],
			isUnique: false,
			where:
				"type = 'documents' AND metadata->>'type' = 'document' AND metadata->>'pinned' = 'true'",
		},
		idx_document_source_search: {
			name: "idx_document_source_search",
			columns: [
				{
					expression:
						"regexp_split_to_array(translate(trim(COALESCE(content->>'text', '')), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), E'[ \\t\\r\\n\\f]+')",
					isExpression: true,
				},
			],
			isUnique: false,
			where:
				"type = 'document_fragments' AND metadata->>'fragmentRole' = 'source-segment'",
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
