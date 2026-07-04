/**
 * Backend-agnostic table schema for the advanced-memory capability's access log:
 * one row per read of a long-term memory or session summary, recording which
 * memory (id + type), which agent, the access type, and when. Feeds usage
 * bookkeeping for stored memories independent of the memory rows themselves.
 */

import type { SchemaTable } from "../../../types/schema.ts";

/**
 * Abstract schema definition for the memory_access_logs table.
 *
 * This is the canonical, backend-agnostic description of the table structure.
 * Database adapters (Drizzle, Knex, raw SQL, etc.) translate this into their
 * own runtime representations.
 */
export const memoryAccessLogs: SchemaTable = {
	name: "memory_access_logs",
	schema: "public",
	columns: {
		id: { name: "id", type: "varchar(36)", primaryKey: true, notNull: true },
		memory_id: { name: "memory_id", type: "varchar(36)", notNull: true },
		memory_type: { name: "memory_type", type: "text", notNull: true },
		agent_id: { name: "agent_id", type: "varchar(36)", notNull: true },
		access_type: { name: "access_type", type: "text", notNull: true },
		accessed_at: {
			name: "accessed_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		},
	},
	indexes: {
		memory_access_logs_memory_id_idx: {
			name: "memory_access_logs_memory_id_idx",
			columns: [{ expression: "memory_id", isExpression: false }],
			isUnique: false,
		},
		memory_access_logs_agent_id_idx: {
			name: "memory_access_logs_agent_id_idx",
			columns: [{ expression: "agent_id", isExpression: false }],
			isUnique: false,
		},
		memory_access_logs_accessed_at_idx: {
			name: "memory_access_logs_accessed_at_idx",
			columns: [{ expression: "accessed_at", isExpression: false }],
			isUnique: false,
		},
	},
	foreignKeys: {},
	compositePrimaryKeys: {},
	uniqueConstraints: {},
	checkConstraints: {},
};
