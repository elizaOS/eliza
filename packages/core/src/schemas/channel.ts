import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the channels table.
 * ID is stored as text (not native uuid).
 */
export const channelSchema: SchemaTable = {
	name: "channels",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "text",
			primaryKey: true,
			notNull: true,
		},
		message_server_id: {
			name: "message_server_id",
			type: "uuid",
			notNull: true,
		},
		name: {
			name: "name",
			type: "text",
			notNull: true,
		},
		type: {
			name: "type",
			type: "text",
			notNull: true,
		},
		source_type: {
			name: "source_type",
			type: "text",
		},
		source_id: {
			name: "source_id",
			type: "text",
		},
		topic: {
			name: "topic",
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
		// WHY: getChannels and findOrCreateDmChannel filter by message_server_id.
		// This is the primary scoping column for channel queries.
		idx_channels_server: {
			name: "idx_channels_server",
			columns: [{ expression: "message_server_id", isExpression: false }],
			isUnique: false,
		},
		// WHY: findOrCreateDmChannel searches by type + name + message_server_id
		// to locate existing DM channels. Without this composite index the
		// lookup scans all channels for the server.
		idx_channels_type_name_server: {
			name: "idx_channels_type_name_server",
			columns: [
				{ expression: "type", isExpression: false },
				{ expression: "name", isExpression: false },
				{ expression: "message_server_id", isExpression: false },
			],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_channel_message_server: {
			name: "fk_channel_message_server",
			tableFrom: "channels",
			tableTo: "message_servers",
			columnsFrom: ["message_server_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
