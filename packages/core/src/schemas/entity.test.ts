/**
 * Tests for entity schema — verifies the entities table descriptor.
 */
import { describe, expect, it } from "vitest";
import { entitySchema } from "./entity.ts";

describe("entity schema", () => {
	it("exports entitySchema with correct table name", () => {
		expect(entitySchema.name).toBe("entities");
	});

	it("has expected columns", () => {
		expect(entitySchema.columns.id.name).toBe("id");
		expect(entitySchema.columns.agent_id.name).toBe("agent_id");
		expect(entitySchema.columns.names.name).toBe("names");
		expect(entitySchema.columns.metadata.name).toBe("metadata");
	});

	it("has id as primary key", () => {
		expect(entitySchema.columns.id.primaryKey).toBe(true);
	});

	it("has indexes on agent_id", () => {
		expect(entitySchema.indexes.idx_entities_agent).toBeDefined();
		expect(entitySchema.indexes.idx_entities_agent.isUnique).toBe(false);
	});

	it("has foreign key to agents", () => {
		expect(entitySchema.foreignKeys.fk_entity_agent).toBeDefined();
		expect(entitySchema.foreignKeys.fk_entity_agent.tableTo).toBe("agents");
	});

	it("has unique constraint on id and agent_id", () => {
		expect(entitySchema.uniqueConstraints.id_agent_id_unique).toBeDefined();
		expect(entitySchema.uniqueConstraints.id_agent_id_unique.columns).toEqual([
			"id",
			"agent_id",
		]);
	});
});
