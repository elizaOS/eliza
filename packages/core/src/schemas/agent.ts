import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the agents table.
 * Contains agent/character configuration and metadata.
 */
export const agentSchema: SchemaTable = {
	name: "agents",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "defaultRandom()",
		},
		enabled: {
			name: "enabled",
			type: "boolean",
			notNull: true,
			default: true,
		},
		server_id: {
			name: "server_id",
			type: "uuid",
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
		name: {
			name: "name",
			type: "text",
			notNull: true,
		},
		username: {
			name: "username",
			type: "text",
		},
		system: {
			name: "system",
			type: "text",
			default: "",
		},
		bio: {
			name: "bio",
			type: "jsonb",
			notNull: true,
			default: "[]",
		},
		message_examples: {
			name: "message_examples",
			type: "jsonb",
			notNull: true,
			default: "[]",
		},
		post_examples: {
			name: "post_examples",
			type: "jsonb",
			notNull: true,
			default: "[]",
		},
		topics: {
			name: "topics",
			type: "jsonb",
			notNull: true,
			default: "[]",
		},
		adjectives: {
			name: "adjectives",
			type: "jsonb",
			notNull: true,
			default: "[]",
		},
		documents: {
			name: "documents",
			type: "jsonb",
			notNull: true,
			default: "[]",
		},
		plugins: {
			name: "plugins",
			type: "jsonb",
			notNull: true,
			default: "[]",
		},
		settings: {
			name: "settings",
			type: "jsonb",
			notNull: true,
			default: "{}",
		},
		style: {
			name: "style",
			type: "jsonb",
			notNull: true,
			default: "{}",
		},
	},
	indexes: {},
	foreignKeys: {},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
