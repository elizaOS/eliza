/**
 * Verifies the pairing allowlist table schema: table identity, column
 * types and nullability defaults, the unique sender/channel/agent index,
 * the non-unique channel/agent lookup index, and the cascading agent
 * foreign key.
 */

import { describe, expect, it } from "vitest";
import { pairingAllowlistSchema } from "./pairing-allowlist";

describe("pairing allowlist schema", () => {
	it("names the pairing_allowlist table with an empty schema qualifier", () => {
		expect(pairingAllowlistSchema.name).toBe("pairing_allowlist");
		expect(pairingAllowlistSchema.schema).toBe("");
	});

	it("declares a generated uuid primary key", () => {
		const id = pairingAllowlistSchema.columns.id;
		expect(id?.type).toBe("uuid");
		expect(id?.primaryKey).toBe(true);
		expect(id?.notNull).toBe(true);
		expect(id?.default).toBe("defaultRandom()");
	});

	it("requires every approved pair to carry channel, sender, and agent attribution", () => {
		expect(pairingAllowlistSchema.columns.channel?.type).toBe("text");
		expect(pairingAllowlistSchema.columns.channel?.notNull).toBe(true);
		expect(pairingAllowlistSchema.columns.sender_id?.type).toBe("text");
		expect(pairingAllowlistSchema.columns.sender_id?.notNull).toBe(true);
		expect(pairingAllowlistSchema.columns.agent_id?.type).toBe("uuid");
		expect(pairingAllowlistSchema.columns.agent_id?.notNull).toBe(true);
	});

	it("timestamps rows at creation and keeps metadata optional jsonb", () => {
		expect(pairingAllowlistSchema.columns.created_at?.type).toBe("timestamp");
		expect(pairingAllowlistSchema.columns.created_at?.notNull).toBe(true);
		expect(pairingAllowlistSchema.columns.created_at?.default).toBe("now()");
		expect(pairingAllowlistSchema.columns.metadata?.type).toBe("jsonb");
		expect(pairingAllowlistSchema.columns.metadata?.notNull).toBeUndefined();
		expect(pairingAllowlistSchema.columns.metadata?.default).toBe("{}");
	});

	it("keeps the channel/agent lookup index non-unique in declared order", () => {
		const lookup =
			pairingAllowlistSchema.indexes.pairing_allowlist_channel_agent_idx;
		expect(lookup?.isUnique).toBe(false);
		expect(lookup?.columns.map((column) => column.expression)).toEqual([
			"channel",
			"agent_id",
		]);
		expect(
			lookup?.columns.every((column) => column.isExpression === false),
		).toBe(true);
	});

	it("uniquely constrains one approval per sender, channel, and agent", () => {
		const unique =
			pairingAllowlistSchema.indexes.pairing_allowlist_sender_channel_agent_idx;
		expect(unique?.isUnique).toBe(true);
		expect(unique?.columns.map((column) => column.expression)).toEqual([
			"sender_id",
			"channel",
			"agent_id",
		]);
	});

	it("cascades row deletion when the owning agent is removed", () => {
		const fk = pairingAllowlistSchema.foreignKeys.fk_pairing_allowlist_agent;
		expect(fk?.tableFrom).toBe("pairing_allowlist");
		expect(fk?.tableTo).toBe("agents");
		expect(fk?.columnsFrom).toEqual(["agent_id"]);
		expect(fk?.columnsTo).toEqual(["id"]);
		expect(fk?.onDelete).toBe("cascade");
		expect(fk?.schemaTo).toBe("");
	});

	it("carries no composite primary keys, unique constraints, or checks", () => {
		expect(pairingAllowlistSchema.compositePrimaryKeys).toEqual({});
		expect(pairingAllowlistSchema.uniqueConstraints).toEqual({});
		expect(pairingAllowlistSchema.checkConstraints).toEqual({});
	});
});
