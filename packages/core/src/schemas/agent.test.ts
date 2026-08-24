/**
 * Unit tests for the `agents` table descriptor (`agentSchema`) — the root of
 * the data model that many core tables foreign-key back to via `agent_id`.
 * Pure declarative-shape assertions over the real exported object — no mocks,
 * no DB: the descriptor itself is the contract adapters materialize. Covers
 * table identity, the full seventeen-column set with nullability and defaults
 * (including the raw boolean default on `enabled`), the sole uuid primary
 * key, the columns requiring explicit values, and the deliberately empty
 * index/constraint maps.
 */
import { describe, expect, it } from "vitest";
import { agentSchema } from "./agent";

describe("agentSchema table identity", () => {
	it("names the agents table in the default schema", () => {
		expect(agentSchema.name).toBe("agents");
		expect(agentSchema.schema).toBe("");
	});
});

describe("agentSchema columns", () => {
	it("declares exactly the seventeen agent columns", () => {
		expect(Object.keys(agentSchema.columns).sort()).toEqual([
			"adjectives",
			"bio",
			"created_at",
			"documents",
			"enabled",
			"id",
			"message_examples",
			"name",
			"plugins",
			"post_examples",
			"server_id",
			"settings",
			"style",
			"system",
			"topics",
			"updated_at",
			"username",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(agentSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("types id as the sole non-null uuid primary key defaulting to defaultRandom()", () => {
		expect(agentSchema.columns.id).toEqual({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "defaultRandom()",
		});
	});

	it("flags no column other than id as a primary key", () => {
		const primaryKeys = Object.entries(agentSchema.columns)
			.filter(([, column]) => column.primaryKey === true)
			.map(([key]) => key);
		expect(primaryKeys).toEqual(["id"]);
	});

	it("marks no column as explicitly unique", () => {
		for (const column of Object.values(agentSchema.columns)) {
			expect(column.isUnique).toBeUndefined();
			expect(column.uniqueName).toBeUndefined();
			expect(column.uniqueType).toBeUndefined();
		}
	});

	it("types enabled as a non-null boolean with a literal true default", () => {
		expect(agentSchema.columns.enabled).toEqual({
			name: "enabled",
			type: "boolean",
			notNull: true,
			default: true,
		});
		expect(agentSchema.columns.enabled.default).toBe(true);
	});

	it("timestamps created_at and updated_at as non-null now()-defaulted columns", () => {
		expect(agentSchema.columns.created_at).toEqual({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
		expect(agentSchema.columns.updated_at).toEqual({
			name: "updated_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("leaves server_id as an optional uuid link without notNull or default", () => {
		expect(agentSchema.columns.server_id.type).toBe("uuid");
		expect(agentSchema.columns.server_id.notNull).toBeUndefined();
		expect(agentSchema.columns.server_id.default).toBeUndefined();
	});

	it("requires name but leaves username optional, both plain text", () => {
		expect(agentSchema.columns.name).toEqual({
			name: "name",
			type: "text",
			notNull: true,
		});
		expect(agentSchema.columns.username.type).toBe("text");
		expect(agentSchema.columns.username.notNull).toBeUndefined();
		expect(agentSchema.columns.username.default).toBeUndefined();
	});

	it("defaults system to an empty string rather than leaving it unset", () => {
		expect(agentSchema.columns.system.type).toBe("text");
		expect(agentSchema.columns.system.default).toBe("");
	});

	it("stores the seven profile-array fields as non-null jsonb defaulting to []", () => {
		const arrayColumns = [
			"adjectives",
			"bio",
			"documents",
			"message_examples",
			"plugins",
			"post_examples",
			"topics",
		] as const;
		for (const key of arrayColumns) {
			const column = agentSchema.columns[key];
			expect(column.type).toBe("jsonb");
			expect(column.notNull).toBe(true);
			expect(column.default).toBe("[]");
		}
	});

	it("stores settings and style as non-null jsonb object maps defaulting to {}", () => {
		for (const key of ["settings", "style"] as const) {
			const column = agentSchema.columns[key];
			expect(column.type).toBe("jsonb");
			expect(column.notNull).toBe(true);
			expect(column.default).toBe("{}");
		}
	});

	it("marks exactly fourteen columns non-null", () => {
		const notNullColumns = Object.entries(agentSchema.columns)
			.filter(([, column]) => column.notNull === true)
			.map(([key]) => key)
			.sort();
		expect(notNullColumns).toEqual([
			"adjectives",
			"bio",
			"created_at",
			"documents",
			"enabled",
			"id",
			"message_examples",
			"name",
			"plugins",
			"post_examples",
			"settings",
			"style",
			"topics",
			"updated_at",
		]);
	});

	it("requires explicit values for exactly name, server_id, and username", () => {
		const withoutDefault = Object.entries(agentSchema.columns)
			.filter(([, column]) => column.default === undefined)
			.map(([key]) => key)
			.sort();
		expect(withoutDefault).toEqual(["name", "server_id", "username"]);
	});
});

describe("agentSchema indexes and constraints", () => {
	it("declares no indexes of its own", () => {
		expect(agentSchema.indexes).toEqual({});
	});

	it("declares no foreign keys — dependant tables reference agents instead", () => {
		expect(agentSchema.foreignKeys).toEqual({});
	});

	it("uses the uuid default as implicit primary key — no composite keys", () => {
		expect(agentSchema.compositePrimaryKeys).toEqual({});
	});

	it("declares no unique or check constraints", () => {
		expect(agentSchema.uniqueConstraints).toEqual({});
		expect(agentSchema.checkConstraints).toEqual({});
	});
});
