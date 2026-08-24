/**
 * Tests for server schema — verifies the servers table descriptor.
 */
import { describe, expect, it } from "vitest";
import { serverSchema } from "./server.ts";

describe("server schema", () => {
	it("exports serverSchema with correct table name", () => {
		expect(serverSchema.name).toBe("servers");
	});

	it("has id column as uuid primary key", () => {
		expect(serverSchema.columns.id.name).toBe("id");
		expect(serverSchema.columns.id.type).toBe("uuid");
		expect(serverSchema.columns.id.primaryKey).toBe(true);
		expect(serverSchema.columns.id.notNull).toBe(true);
	});

	it("has created_at and updated_at timestamp columns", () => {
		expect(serverSchema.columns.created_at.name).toBe("created_at");
		expect(serverSchema.columns.created_at.type).toBe("timestamp");
		expect(serverSchema.columns.created_at.notNull).toBe(true);
		expect(serverSchema.columns.updated_at.name).toBe("updated_at");
		expect(serverSchema.columns.updated_at.type).toBe("timestamp");
		expect(serverSchema.columns.updated_at.notNull).toBe(true);
	});

	it("has empty indexes and foreignKeys", () => {
		expect(serverSchema.indexes).toEqual({});
		expect(serverSchema.foreignKeys).toEqual({});
	});

	it("has empty constraints", () => {
		expect(serverSchema.uniqueConstraints).toEqual({});
		expect(serverSchema.checkConstraints).toEqual({});
	});
});
