/**
 * Tests for component schema — abstract SchemaTable descriptor.
 */
import { describe, expect, it } from "vitest";
import { componentSchema } from "./component.ts";

describe("component schema", () => {
	it("has expected table name and columns", () => {
		expect(componentSchema.name).toBe("components");
		expect(componentSchema.columns.id.type).toBe("uuid");
		expect(componentSchema.columns.entity_id.notNull).toBe(true);
		expect(componentSchema.columns.type.type).toBe("text");
	});

	it("has expected indexes", () => {
		expect(componentSchema.indexes.idx_components_entity_type).toBeDefined();
		expect(componentSchema.indexes.idx_components_entity_type.isUnique).toBe(
			false,
		);
	});

	it("has foreign keys", () => {
		expect(Object.keys(componentSchema.foreignKeys).length).toBeGreaterThan(0);
	});

	it("has data jsonb column", () => {
		expect(componentSchema.columns.data.type).toBe("jsonb");
	});

	it("has created_at timestamp", () => {
		expect(componentSchema.columns.created_at.type).toBe("timestamp");
	});
});
