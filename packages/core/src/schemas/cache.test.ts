/**
 * Unit tests for the per-agent cache table descriptor (`cacheSchema`) that
 * backs runtime key/value caching scoped by agent. Pure declarative-shape
 * assertions over the real exported object — no mocks, no DB: the descriptor
 * itself is the contract adapters materialize. Covers table identity, the
 * full column set with nullability and defaults, the absence of standalone
 * indexes, the cascading agent foreign key, and the (key, agent_id) composite
 * primary key plus the empty constraint maps.
 */
import { describe, expect, it } from "vitest";
import { cacheSchema } from "./cache";

describe("cacheSchema table identity", () => {
	it("names the cache table in the default schema", () => {
		expect(cacheSchema.name).toBe("cache");
		expect(cacheSchema.schema).toBe("");
	});
});

describe("cacheSchema columns", () => {
	it("declares exactly the five cache columns", () => {
		expect(Object.keys(cacheSchema.columns).sort()).toEqual([
			"agent_id",
			"created_at",
			"expires_at",
			"key",
			"value",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(cacheSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("marks key as non-null text without a default", () => {
		expect(cacheSchema.columns.key.type).toBe("text");
		expect(cacheSchema.columns.key.notNull).toBe(true);
		expect(cacheSchema.columns.key.default).toBeUndefined();
	});

	it("marks agent_id as a non-null uuid without a default", () => {
		expect(cacheSchema.columns.agent_id.type).toBe("uuid");
		expect(cacheSchema.columns.agent_id.notNull).toBe(true);
		expect(cacheSchema.columns.agent_id.default).toBeUndefined();
	});

	it("marks value as non-null jsonb without a default", () => {
		expect(cacheSchema.columns.value.type).toBe("jsonb");
		expect(cacheSchema.columns.value.notNull).toBe(true);
		expect(cacheSchema.columns.value.default).toBeUndefined();
	});

	it("types created_at as a non-null timestamp defaulting to now()", () => {
		expect(cacheSchema.columns.created_at).toEqual({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("leaves expires_at as the single nullable timestamp column without a default", () => {
		expect(cacheSchema.columns.expires_at.type).toBe("timestamp");
		expect(cacheSchema.columns.expires_at.notNull).toBeUndefined();
		expect(cacheSchema.columns.expires_at.default).toBeUndefined();
		const nullableColumns = Object.entries(cacheSchema.columns)
			.filter(([, column]) => !column.notNull)
			.map(([key]) => key);
		expect(nullableColumns).toEqual(["expires_at"]);
	});

	it("declares no defaults beyond created_at", () => {
		for (const [key, column] of Object.entries(cacheSchema.columns)) {
			if (key !== "created_at") {
				expect(column.default).toBeUndefined();
			}
		}
	});

	it("declares no per-column primary key — identity comes from the composite key", () => {
		for (const column of Object.values(cacheSchema.columns)) {
			expect(column.primaryKey).toBeUndefined();
		}
	});
});

describe("cacheSchema indexes", () => {
	it("declares no standalone indexes", () => {
		expect(cacheSchema.indexes).toEqual({});
	});
});

describe("cacheSchema foreignKeys", () => {
	it("cascades agent deletion through fk_cache_agent to agents.id", () => {
		expect(cacheSchema.foreignKeys.fk_cache_agent).toEqual({
			name: "fk_cache_agent",
			tableFrom: "cache",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("declares no foreign keys beyond the agent cascade link", () => {
		expect(Object.keys(cacheSchema.foreignKeys)).toEqual(["fk_cache_agent"]);
	});

	it("references only columns that exist on the table and target", () => {
		for (const foreignKey of Object.values(cacheSchema.foreignKeys)) {
			expect(foreignKey.tableFrom).toBe(cacheSchema.name);
			for (const column of foreignKey.columnsFrom) {
				expect(cacheSchema.columns[column]).toBeDefined();
			}
		}
	});
});

describe("cacheSchema composite primary key", () => {
	it("uniquely identifies entries per agent through cache_pk on (key, agent_id)", () => {
		expect(cacheSchema.compositePrimaryKeys.cache_pk).toEqual({
			name: "cache_pk",
			columns: ["key", "agent_id"],
		});
	});

	it("declares no composite keys beyond cache_pk", () => {
		expect(Object.keys(cacheSchema.compositePrimaryKeys)).toEqual(["cache_pk"]);
	});

	it("builds the composite key only from columns that exist on the table", () => {
		for (const primaryKey of Object.values(cacheSchema.compositePrimaryKeys)) {
			for (const column of primaryKey.columns) {
				expect(cacheSchema.columns[column]).toBeDefined();
			}
		}
	});
});

describe("cacheSchema constraint maps", () => {
	it("declares no unique constraints or check constraints", () => {
		expect(cacheSchema.uniqueConstraints).toEqual({});
		expect(cacheSchema.checkConstraints).toEqual({});
	});
});
