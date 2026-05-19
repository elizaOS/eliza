import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the pairing_requests table.
 * Has multiple unique indexes.
 */
export const pairingRequestSchema: SchemaTable = {
	name: "pairing_requests",
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
		code: {
			name: "code",
			type: "text",
			notNull: true,
		},
		created_at: {
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
		last_seen_at: {
			name: "last_seen_at",
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
		pairing_requests_channel_agent_idx: {
			name: "pairing_requests_channel_agent_idx",
			columns: [
				{ expression: "channel", isExpression: false },
				{ expression: "agent_id", isExpression: false },
			],
			isUnique: false,
		},
		pairing_requests_code_channel_agent_idx: {
			name: "pairing_requests_code_channel_agent_idx",
			columns: [
				{ expression: "code", isExpression: false },
				{ expression: "channel", isExpression: false },
				{ expression: "agent_id", isExpression: false },
			],
			isUnique: true,
		},
		pairing_requests_sender_channel_agent_idx: {
			name: "pairing_requests_sender_channel_agent_idx",
			columns: [
				{ expression: "sender_id", isExpression: false },
				{ expression: "channel", isExpression: false },
				{ expression: "agent_id", isExpression: false },
			],
			isUnique: true,
		},
	},
	foreignKeys: {
		fk_pairing_request_agent: {
			name: "fk_pairing_request_agent",
			tableFrom: "pairing_requests",
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
