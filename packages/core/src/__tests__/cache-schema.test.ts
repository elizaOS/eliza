import { describe, expect, it } from "vitest";
import { cacheSchema } from "../schemas/cache.ts";
import type { SchemaTable } from "../types/schema.ts";

describe("cacheSchema", () => {
	it("declares the canonical cache table name", () => {
		expect(cacheSchema.name).toBe("cache");
	});

	it("satisfies the SchemaTable contract", () => {
		const table: SchemaTable = cacheSchema;
		expect(table).toBeDefined();
	});

	it("declares key and agent_id as non-null composite primary key columns", () => {
		expect(cacheSchema.columns.key).toMatchObject({
			name: "key",
			type: "text",
			notNull: true,
		});
		expect(cacheSchema.columns.agent_id).toMatchObject({
			name: "agent_id",
			type: "uuid",
			notNull: true,
		});
	});

	it("declares value as a non-null jsonb column", () => {
		expect(cacheSchema.columns.value).toMatchObject({
			name: "value",
			type: "jsonb",
			notNull: true,
		});
	});

	it("defaults created_at to now() and keeps expires_at nullable", () => {
		expect(cacheSchema.columns.created_at).toMatchObject({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
		expect(cacheSchema.columns.expires_at).toMatchObject({
			name: "expires_at",
			type: "timestamp",
		});
		expect(cacheSchema.columns.expires_at.notNull).toBeFalsy();
	});

	it("defines the composite primary key on (key, agent_id)", () => {
		expect(Object.values(cacheSchema.compositePrimaryKeys)).toHaveLength(1);
		const pk = Object.values(cacheSchema.compositePrimaryKeys)[0];
		expect(pk.columns).toEqual(["key", "agent_id"]);
	});

	it("cascade-deletes the cache row with its owning agent", () => {
		expect(cacheSchema.foreignKeys.fk_cache_agent).toMatchObject({
			name: "fk_cache_agent",
			tableFrom: "cache",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
		});
	});

	it("keeps every declared column in the columns map", () => {
		const columnNames = Object.values(cacheSchema.columns).map((c) => c.name);
		expect(columnNames).toEqual(
			expect.arrayContaining([
				"key",
				"agent_id",
				"value",
				"created_at",
				"expires_at",
			]),
		);
		for (const [key, column] of Object.entries(cacheSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});
});
