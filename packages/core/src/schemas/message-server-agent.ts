import type { SchemaTable } from "../types/schema.ts";

/**
 * Abstract schema for the message_server_agents table.
 * Junction table with composite primary key.
 */
export const messageServerAgentSchema: SchemaTable = {
	name: "message_server_agents",
	schema: "",
	columns: {
		message_server_id: {
			name: "message_server_id",
			type: "uuid",
			notNull: true,
		},
		agent_id: {
			name: "agent_id",
			type: "uuid",
			notNull: true,
		},
	},
	indexes: {
		// WHY: getMessageServers filters by agent_id. The composite PK is
		// (message_server_id, agent_id), so agent_id-only lookups cannot use
		// the PK index efficiently — they need a separate index.
		idx_msa_agent: {
			name: "idx_msa_agent",
			columns: [{ expression: "agent_id", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {
		fk_message_server_agent_server: {
			name: "fk_message_server_agent_server",
			tableFrom: "message_server_agents",
			tableTo: "message_servers",
			columnsFrom: ["message_server_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
		fk_message_server_agent_agent: {
			name: "fk_message_server_agent_agent",
			tableFrom: "message_server_agents",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		},
	},
	compositePrimaryKeys: {
		message_server_agents_pk: {
			name: "message_server_agents_pk",
			columns: ["message_server_id", "agent_id"],
		},
	},
	uniqueConstraints: {},
	checkConstraints: {},
};
