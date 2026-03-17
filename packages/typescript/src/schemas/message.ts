import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the central_messages table.
 * Has a self-referencing foreign key (in_reply_to_root_message_id).
 */
export const messageSchema: SchemaTable = {
	name: "central_messages",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "text",
			primaryKey: true,
			notNull: true,
		},
		channel_id: {
			name: "channel_id",
			type: "text",
			notNull: true,
		},
		author_id: {
			name: "author_id",
			type: "text",
			notNull: true,
		},
		content: {
			name: "content",
			type: "text",
			notNull: true,
		},
		raw_message: {
			name: "raw_message",
			type: "jsonb",
		},
		in_reply_to_root_message_id: {
			name: "in_reply_to_root_message_id",
			type: "text",
		},
		source_type: {
			name: "source_type",
			type: "text",
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
		// WHY: getMessages and getMessagesByChannelIds always filter by
		// channel_id and order by created_at DESC. This composite index
		// supports both range scans and ordered retrieval without a sort step.
		idx_messages_channel_created: {
			name: "idx_messages_channel_created",
			columns: [
				{ expression: "channel_id", isExpression: false },
				{ expression: "created_at", isExpression: false },
			],
			isUnique: false,
		},
		// WHY: Author-based lookups (e.g., "find messages by user in a channel")
		// and join patterns that resolve message authors.
		idx_messages_author: {
			name: "idx_messages_author",
			columns: [{ expression: "author_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_message_channel: {
			name: "fk_message_channel",
			tableFrom: "central_messages",
			tableTo: "channels",
			columnsFrom: ["channel_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_message_reply: {
			name: "fk_message_reply",
			tableFrom: "central_messages",
			tableTo: "central_messages",
			columnsFrom: ["in_reply_to_root_message_id"],
			columnsTo: ["id"],
			onDelete: "set null",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
