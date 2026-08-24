import { describe, expect, it } from "vitest";
import { serverSchema } from "../schemas/server.ts";
import type { SchemaTable } from "../types/schema.ts";

describe("serverSchema", () => {
	it("declares the canonical servers table name", () => {
		expect(serverSchema.name).toBe("servers");
	});

	it("satisfies the SchemaTable contract", () => {
		const table: SchemaTable = serverSchema;
		expect(table).toBeDefined();
	});

	it("declares the id column as a non-null uuid primary key", () => {
		expect(serverSchema.columns.id).toMatchObject({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		});
	});

	it("declares created_at and updated_at as non-null timestamps", () => {
		expect(serverSchema.columns.created_at).toMatchObject({
			name: "created_at",
			type: "timestamp",
			notNull: true,
		});
		expect(serverSchema.columns.updated_at).toMatchObject({
			name: "updated_at",
			type: "timestamp",
			notNull: true,
		});
	});

	it("defaults created_at and updated_at to now()", () => {
		expect(serverSchema.columns.created_at.default).toBe("now()");
		expect(serverSchema.columns.updated_at.default).toBe("now()");
	});

	it("keeps every declared column in the columns map", () => {
		const columnNames = Object.values(serverSchema.columns).map((c) => c.name);
		expect(columnNames).toEqual(
			expect.arrayContaining(["id", "created_at", "updated_at"]),
		);
		// No column declares a name that differs from its key.
		for (const [key, column] of Object.entries(serverSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("declares no composite keys or foreign keys for the tenant root table", () => {
		expect(Object.keys(serverSchema.compositePrimaryKeys)).toHaveLength(0);
		expect(Object.keys(serverSchema.foreignKeys)).toHaveLength(0);
		expect(Object.keys(serverSchema.uniqueConstraints)).toHaveLength(0);
	});
});
