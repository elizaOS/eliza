/**
 * Verifies the backend-agnostic memory-access log schema exposes the complete
 * column, timestamp-default, index, and constraint contract expected by
 * database adapters.
 */

import { describe, expect, it } from "vitest";
import { memoryAccessLogs } from "./memory-access-logs";

describe("memoryAccessLogs", () => {
	it("identifies the public memory_access_logs table", () => {
		expect(memoryAccessLogs.name).toBe("memory_access_logs");
		expect(memoryAccessLogs.schema).toBe("public");
	});

	it("defines every access-log column with its storage contract", () => {
		expect(memoryAccessLogs.columns).toEqual({
			id: {
				name: "id",
				type: "varchar(36)",
				primaryKey: true,
				notNull: true,
			},
			memory_id: {
				name: "memory_id",
				type: "varchar(36)",
				notNull: true,
			},
			memory_type: { name: "memory_type", type: "text", notNull: true },
			agent_id: {
				name: "agent_id",
				type: "varchar(36)",
				notNull: true,
			},
			access_type: { name: "access_type", type: "text", notNull: true },
			accessed_at: {
				name: "accessed_at",
				type: "timestamp",
				notNull: true,
				default: "now()",
			},
		});
	});

	it("indexes memory, agent, and access time without imposing uniqueness", () => {
		expect(memoryAccessLogs.indexes).toEqual({
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
		});
	});

	it("declares no additional relational or value constraints", () => {
		expect(memoryAccessLogs.foreignKeys).toEqual({});
		expect(memoryAccessLogs.compositePrimaryKeys).toEqual({});
		expect(memoryAccessLogs.uniqueConstraints).toEqual({});
		expect(memoryAccessLogs.checkConstraints).toEqual({});
	});
});
