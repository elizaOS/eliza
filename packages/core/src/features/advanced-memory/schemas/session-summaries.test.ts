/**
 * Deterministic unit coverage for the advanced-memory session summary table
 * definition, including its complete column, index, and constraint contracts.
 */

import { describe, expect, it } from "vitest";
import { sessionSummaries } from "./session-summaries.ts";

describe("sessionSummaries", () => {
	it("defines the public session summaries table", () => {
		expect(sessionSummaries.name).toBe("session_summaries");
		expect(sessionSummaries.schema).toBe("public");
	});

	it("defines every required and optional summary column", () => {
		expect(sessionSummaries.columns).toEqual({
			id: {
				name: "id",
				type: "varchar(36)",
				primaryKey: true,
				notNull: true,
			},
			agent_id: { name: "agent_id", type: "varchar(36)", notNull: true },
			room_id: { name: "room_id", type: "varchar(36)", notNull: true },
			entity_id: { name: "entity_id", type: "varchar(36)" },
			summary: { name: "summary", type: "text", notNull: true },
			message_count: { name: "message_count", type: "integer", notNull: true },
			last_message_offset: {
				name: "last_message_offset",
				type: "integer",
				notNull: true,
				default: 0,
			},
			start_time: { name: "start_time", type: "timestamp", notNull: true },
			end_time: { name: "end_time", type: "timestamp", notNull: true },
			topics: { name: "topics", type: "jsonb" },
			metadata: { name: "metadata", type: "jsonb" },
			embedding: { name: "embedding", type: "real[]" },
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
		});
	});

	it("indexes room lookup first and exposes each secondary lookup", () => {
		expect(sessionSummaries.indexes).toEqual({
			session_summaries_agent_room_idx: {
				name: "session_summaries_agent_room_idx",
				columns: [
					{ expression: "agent_id", isExpression: false },
					{ expression: "room_id", isExpression: false },
				],
				isUnique: false,
			},
			session_summaries_entity_idx: {
				name: "session_summaries_entity_idx",
				columns: [{ expression: "entity_id", isExpression: false }],
				isUnique: false,
			},
			session_summaries_start_time_idx: {
				name: "session_summaries_start_time_idx",
				columns: [{ expression: "start_time", isExpression: false }],
				isUnique: false,
			},
		});
	});

	it("declares no additional constraints", () => {
		expect(sessionSummaries.foreignKeys).toEqual({});
		expect(sessionSummaries.compositePrimaryKeys).toEqual({});
		expect(sessionSummaries.uniqueConstraints).toEqual({});
		expect(sessionSummaries.checkConstraints).toEqual({});
	});
});
