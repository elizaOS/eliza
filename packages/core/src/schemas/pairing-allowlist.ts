import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the pairing_allowlist table.
 * Has multiple indexes including a unique constraint.
 */
export const pairingAllowlistSchema: SchemaTable = {
	name: "pairing_allowlist",
	schema: "",
	columns: {
		id: {
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "defaultRandom()",
		},
		channel: {
			name: "channel",
			type: "text",
			notNull: true,
		},
		sender_id: {
			name: "sender_id",
			type: "text",
			notNull: true,
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		metadata: {
			name: "metadata",
			type: "jsonb",
			default: "{}",
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
	},
	indexes: {
		pairing_allowlist_channel_agent_idx: {
			name: "pairing_allowlist_channel_agent_idx",
			columns: [
				{ expression: "channel", isExpression: false },
				{ expression: "agent_id", isExpression: false },
			],
			isUnique: false,
		},
		pairing_allowlist_sender_channel_agent_idx: {
			name: "pairing_allowlist_sender_channel_agent_idx",
			columns: [
				{ expression: "sender_id", isExpression: false },
				{ expression: "channel", isExpression: false },
				{ expression: "agent_id", isExpression: false },
			],
			isUnique: true,
		},
	},
	foreignKeys: {
		fk_pairing_allowlist_agent: {
			name: "fk_pairing_allowlist_agent",
			tableFrom: "pairing_allowlist",
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
