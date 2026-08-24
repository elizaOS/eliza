/**
 * Unit tests for the `message_server_agents` junction-table descriptor
 * (`messageServerAgentSchema`) — a pure portable `SchemaTable` constant, so the
 * suite drives the real exported data with no mocks or database. Covers the
 * junction columns, composite-PK ordering, cascade FKs into the real `agents`
 * and `message_servers` descriptors, and the agent_id-only lookup index.
 */
import { describe, expect, it } from "vitest";
import { agentSchema } from "./agent";
import { messageServerSchema } from "./message-server";
import { messageServerAgentSchema } from "./message-server-agent";

describe("messageServerAgentSchema", () => {
	const schema = messageServerAgentSchema;

	it("describes the message_server_agents table", () => {
		expect(schema.name).toBe("message_server_agents");
		expect(schema.schema).toBe("");
	});

	it("has exactly the two junction columns, both non-null uuids", () => {
		expect(Object.keys(schema.columns).sort()).toEqual([
			"agent_id",
			"message_server_id",
		]);
		for (const key of ["message_server_id", "agent_id"] as const) {
			const column = schema.columns[key];
			expect(column.name).toBe(key);
			expect(column.type).toBe("uuid");
			expect(column.notNull).toBe(true);
		}
	});

	it("keys rows by the composite PK (message_server_id, agent_id) in that order", () => {
		const pks = Object.values(schema.compositePrimaryKeys);
		expect(pks).toHaveLength(1);
		expect(pks[0].name).toBe("message_server_agents_pk");
		expect(pks[0].columns).toEqual(["message_server_id", "agent_id"]);
	});

	it("cascades deletion from either parent down to the junction row", () => {
		const serverFk = schema.foreignKeys.fk_message_server_agent_server;
		const agentFk = schema.foreignKeys.fk_message_server_agent_agent;

		expect(serverFk.tableTo).toBe("message_servers");
		expect(serverFk.columnsFrom).toEqual(["message_server_id"]);
		expect(serverFk.columnsTo).toEqual(["id"]);
		expect(serverFk.onDelete).toBe("cascade");

		expect(agentFk.tableTo).toBe("agents");
		expect(agentFk.columnsFrom).toEqual(["agent_id"]);
		expect(agentFk.columnsTo).toEqual(["id"]);
		expect(agentFk.onDelete).toBe("cascade");

		for (const fk of Object.values(schema.foreignKeys)) {
			expect(fk.tableFrom).toBe("message_server_agents");
			expect(fk.schemaTo).toBe("");
			expect(fk.columnsFrom).toHaveLength(fk.columnsTo.length);
		}
	});

	it("points each FK at an existing uuid primary key on its parent table", () => {
		for (const [fkName, parent] of [
			["fk_message_server_agent_server", messageServerSchema],
			["fk_message_server_agent_agent", agentSchema],
		] as const) {
			const fk = schema.foreignKeys[fkName];
			expect(parent.name).toBe(fk.tableTo);
			const targetColumn = parent.columns[fk.columnsTo[0]];
			expect(targetColumn).toBeDefined();
			expect(targetColumn.type).toBe("uuid");
			expect(targetColumn.primaryKey).toBe(true);
			expect(targetColumn.notNull).toBe(true);
		}
	});

	it("indexes agent_id alone as a plain column for getMessageServers lookups", () => {
		expect(Object.keys(schema.indexes)).toEqual(["idx_msa_agent"]);
		const index = schema.indexes.idx_msa_agent;
		expect(index.name).toBe("idx_msa_agent");
		expect(index.isUnique).toBe(false);
		expect(index.columns).toHaveLength(1);
		expect(index.columns[0]).toEqual({
			expression: "agent_id",
			isExpression: false,
		});
	});

	it("declares no unique or check constraints beyond the composite PK", () => {
		expect(schema.uniqueConstraints).toEqual({});
		expect(schema.checkConstraints).toEqual({});
	});
});
