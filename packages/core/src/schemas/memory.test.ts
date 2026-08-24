/**
 * Tests for memory schema — abstract SchemaTable descriptor.
 */
import { describe, expect, it } from "vitest";
import { memorySchema } from "./memory.ts";

describe("memory schema", () => {
	it("has expected table name and primary key", () => {
		expect(memorySchema.name).toBe("memories");
		expect(memorySchema.columns.id.primaryKey).toBe(true);
		expect(memorySchema.columns.id.type).toBe("uuid");
	});

	it("has required content and type columns", () => {
		expect(memorySchema.columns.content.type).toBe("jsonb");
		expect(memorySchema.columns.content.notNull).toBe(true);
		expect(memorySchema.columns.type.notNull).toBe(true);
	});

	it("has agent_id notNull", () => {
		expect(memorySchema.columns.agent_id.notNull).toBe(true);
	});

	it("has expected indexes", () => {
		expect(memorySchema.indexes.idx_memories_agent_type).toBeDefined();
		expect(memorySchema.indexes.idx_memories_agent_type.isUnique).toBe(false);
	});

	it("has check constraints", () => {
		expect(Object.keys(memorySchema.checkConstraints).length).toBeGreaterThan(
			0,
		);
	});
});
