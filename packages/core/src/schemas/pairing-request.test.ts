/**
 * Verifies the pairing requests table schema: table identity, required
 * channel/sender/code/agent attribution columns, creation and last-seen
 * timestamps, the non-unique channel/agent lookup index, the unique code
 * and sender indexes, and the cascading agent foreign key.
 */

import { describe, expect, it } from "vitest";
import { pairingRequestSchema } from "./pairing-request";

describe("pairing request schema", () => {
	it("names the pairing_requests table with an empty schema qualifier", () => {
		expect(pairingRequestSchema.name).toBe("pairing_requests");
		expect(pairingRequestSchema.schema).toBe("");
	});

	it("declares a generated uuid primary key", () => {
		const id = pairingRequestSchema.columns.id;
		expect(id?.type).toBe("uuid");
		expect(id?.primaryKey).toBe(true);
		expect(id?.notNull).toBe(true);
		expect(id?.default).toBe("defaultRandom()");
	});

	it("requires every pending handshake to carry channel, sender, and agent attribution", () => {
		expect(pairingRequestSchema.columns.channel?.type).toBe("text");
		expect(pairingRequestSchema.columns.channel?.notNull).toBe(true);
		expect(pairingRequestSchema.columns.sender_id?.type).toBe("text");
		expect(pairingRequestSchema.columns.sender_id?.notNull).toBe(true);
		expect(pairingRequestSchema.columns.agent_id?.type).toBe("uuid");
		expect(pairingRequestSchema.columns.agent_id?.notNull).toBe(true);
	});

	it("requires a pairing code with no server-side default", () => {
		const code = pairingRequestSchema.columns.code;
		expect(code?.type).toBe("text");
		expect(code?.notNull).toBe(true);
		expect(code?.default).toBeUndefined();
	});

	it("timestamps creation and last-seen and keeps metadata optional jsonb", () => {
		expect(pairingRequestSchema.columns.created_at?.type).toBe("timestamp");
		expect(pairingRequestSchema.columns.created_at?.notNull).toBe(true);
		expect(pairingRequestSchema.columns.created_at?.default).toBe("now()");
		expect(pairingRequestSchema.columns.last_seen_at?.type).toBe("timestamp");
		expect(pairingRequestSchema.columns.last_seen_at?.notNull).toBe(true);
		expect(pairingRequestSchema.columns.last_seen_at?.default).toBe("now()");
		expect(pairingRequestSchema.columns.metadata?.type).toBe("jsonb");
		expect(pairingRequestSchema.columns.metadata?.notNull).toBeUndefined();
		expect(pairingRequestSchema.columns.metadata?.default).toBe("{}");
	});

	it("keeps the channel/agent lookup index non-unique in declared order", () => {
		const lookup =
			pairingRequestSchema.indexes.pairing_requests_channel_agent_idx;
		expect(lookup?.isUnique).toBe(false);
		expect(lookup?.columns.map((column) => column.expression)).toEqual([
			"channel",
			"agent_id",
		]);
		expect(
			lookup?.columns.every((column) => column.isExpression === false),
		).toBe(true);
	});

	it("uniquely constrains one live code per channel and agent", () => {
		const unique =
			pairingRequestSchema.indexes.pairing_requests_code_channel_agent_idx;
		expect(unique?.isUnique).toBe(true);
		expect(unique?.columns.map((column) => column.expression)).toEqual([
			"code",
			"channel",
			"agent_id",
		]);
	});

	it("uniquely constrains one pending request per sender, channel, and agent", () => {
		const unique =
			pairingRequestSchema.indexes.pairing_requests_sender_channel_agent_idx;
		expect(unique?.isUnique).toBe(true);
		expect(unique?.columns.map((column) => column.expression)).toEqual([
			"sender_id",
			"channel",
			"agent_id",
		]);
	});

	it("cascades row deletion when the owning agent is removed", () => {
		const fk = pairingRequestSchema.foreignKeys.fk_pairing_request_agent;
		expect(fk?.tableFrom).toBe("pairing_requests");
		expect(fk?.tableTo).toBe("agents");
		expect(fk?.columnsFrom).toEqual(["agent_id"]);
		expect(fk?.columnsTo).toEqual(["id"]);
		expect(fk?.onDelete).toBe("cascade");
		expect(fk?.schemaTo).toBe("");
	});

	it("carries no composite primary keys, unique constraints, or checks", () => {
		expect(pairingRequestSchema.compositePrimaryKeys).toEqual({});
		expect(pairingRequestSchema.uniqueConstraints).toEqual({});
		expect(pairingRequestSchema.checkConstraints).toEqual({});
	});

	it("keeps every index and column internally consistent for adapter materialization", () => {
		const columnNames = Object.keys(pairingRequestSchema.columns);
		expect(columnNames).toHaveLength(8);
		for (const [key, column] of Object.entries(pairingRequestSchema.columns)) {
			expect(column.name).toBe(key);
		}
		const uniqueIndexes = Object.entries(pairingRequestSchema.indexes).filter(
			([, index]) => index.isUnique,
		);
		expect(uniqueIndexes.map(([key]) => key).sort()).toEqual([
			"pairing_requests_code_channel_agent_idx",
			"pairing_requests_sender_channel_agent_idx",
		]);
		for (const [key, index] of Object.entries(pairingRequestSchema.indexes)) {
			expect(index.name).toBe(key);
			for (const column of index.columns) {
				expect(columnNames).toContain(column.expression);
			}
		}
		for (const fk of Object.values(pairingRequestSchema.foreignKeys)) {
			for (const column of fk.columnsFrom) {
				expect(columnNames).toContain(column);
			}
		}
	});
});
