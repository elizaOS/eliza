import { describe, expect, it } from "vitest";
import { componentSchema } from "../schemas/component.ts";
import type { SchemaTable } from "../types/schema.ts";

describe("componentSchema", () => {
	it("declares the canonical components table name", () => {
		expect(componentSchema.name).toBe("components");
	});

	it("satisfies the SchemaTable contract", () => {
		const table: SchemaTable = componentSchema;
		expect(table).toBeDefined();
	});

	it("declares id as a non-null uuid primary key with gen_random_uuid", () => {
		expect(componentSchema.columns.id).toMatchObject({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		});
	});

	it("requires entity_id, agent_id, room_id, and type", () => {
		expect(componentSchema.columns.entity_id).toMatchObject({
			name: "entity_id",
			type: "uuid",
			notNull: true,
		});
		expect(componentSchema.columns.agent_id).toMatchObject({
			name: "agent_id",
			type: "uuid",
			notNull: true,
		});
		expect(componentSchema.columns.room_id).toMatchObject({
			name: "room_id",
			type: "uuid",
			notNull: true,
		});
		expect(componentSchema.columns.type).toMatchObject({
			name: "type",
			type: "text",
			notNull: true,
		});
	});

	it("keeps world_id and source_entity_id nullable", () => {
		expect(componentSchema.columns.world_id.notNull).toBeFalsy();
		expect(componentSchema.columns.source_entity_id.notNull).toBeFalsy();
	});

	it("defaults the data jsonb column to an empty object", () => {
		expect(componentSchema.columns.data).toMatchObject({
			name: "data",
			type: "jsonb",
			default: "{}",
		});
	});

	it("defaults created_at to now()", () => {
		expect(componentSchema.columns.created_at).toMatchObject({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("indexes the entity_id + type access pattern", () => {
		const idx = componentSchema.indexes.idx_components_entity_type;
		expect(idx).toBeDefined();
		expect(idx.columns.map((c) => c.expression)).toEqual(["entity_id", "type"]);
		expect(idx.isUnique).toBe(false);
	});

	it("keeps every declared column in the columns map", () => {
		const columnNames = Object.values(componentSchema.columns).map(
			(c) => c.name,
		);
		expect(columnNames).toEqual(
			expect.arrayContaining([
				"id",
				"entity_id",
				"agent_id",
				"room_id",
				"world_id",
				"source_entity_id",
				"type",
				"data",
				"created_at",
			]),
		);
		for (const [key, column] of Object.entries(componentSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});
});
