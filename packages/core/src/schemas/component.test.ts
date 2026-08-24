/**
 * Exercises the canonical `componentSchema` table definition — table identity,
 * primary key, required vs nullable columns, every index and foreign key, and
 * the NULLS NOT DISTINCT natural-key uniqueness that makes component upserts
 * idempotent. Pure data-object assertions with no database in the loop.
 */
import { describe, expect, it } from "vitest";
import { componentSchema } from "./component";

describe("componentSchema identity", () => {
	it("targets the components table in the default schema", () => {
		expect(componentSchema.name).toBe("components");
		expect(componentSchema.schema).toBe("");
	});

	it("uses a single-column generated uuid primary key", () => {
		const primaryKeyColumns = Object.values(componentSchema.columns).filter(
			(column) => column.primaryKey === true,
		);
		expect(primaryKeyColumns).toHaveLength(1);
		expect(primaryKeyColumns[0]?.name).toBe("id");
		expect(componentSchema.columns.id).toMatchObject({
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		});
		expect(componentSchema.compositePrimaryKeys).toEqual({});
	});
});

describe("componentSchema columns", () => {
	it("marks entity, agent, and room scoping as required", () => {
		for (const columnName of ["entity_id", "agent_id", "room_id"]) {
			const column = componentSchema.columns[columnName];
			expect(column).toBeDefined();
			expect(column?.type).toBe("uuid");
			expect(column?.notNull).toBe(true);
		}
	});

	it("leaves world and source-entity scoping nullable", () => {
		for (const columnName of ["world_id", "source_entity_id"]) {
			const column = componentSchema.columns[columnName];
			expect(column).toBeDefined();
			expect(column?.type).toBe("uuid");
			expect(column?.notNull).toBeUndefined();
		}
	});

	it("requires the component type discriminator", () => {
		const column = componentSchema.columns.type;
		expect(column).toBeDefined();
		expect(column?.type).toBe("text");
		expect(column?.notNull).toBe(true);
	});

	it("defaults jsonb data to an empty object", () => {
		const column = componentSchema.columns.data;
		expect(column).toBeDefined();
		expect(column?.type).toBe("jsonb");
		expect(column?.default).toBe("{}");
		expect(column?.notNull).toBeUndefined();
	});

	it("requires created_at with a now() default", () => {
		const column = componentSchema.columns.created_at;
		expect(column).toBeDefined();
		expect(column?.type).toBe("timestamp");
		expect(column?.notNull).toBe(true);
		expect(column?.default).toBe("now()");
	});

	it("exposes exactly the nine documented columns", () => {
		expect(Object.keys(componentSchema.columns)).toEqual([
			"id",
			"entity_id",
			"agent_id",
			"room_id",
			"world_id",
			"source_entity_id",
			"type",
			"data",
			"created_at",
		]);
	});
});

describe("componentSchema indexes", () => {
	it("defines exactly four named indexes", () => {
		expect(Object.keys(componentSchema.indexes)).toEqual([
			"idx_components_entity_type",
			"idx_components_agent_entity",
			"idx_components_world",
			"idx_components_data_gin",
		]);
	});

	it("supports getComponent's entity + type filter as plain columns", () => {
		const index = componentSchema.indexes.idx_components_entity_type;
		expect(index).toMatchObject({
			name: "idx_components_entity_type",
			isUnique: false,
		});
		expect(index?.columns).toEqual([
			{ expression: "entity_id", isExpression: false },
			{ expression: "type", isExpression: false },
		]);
	});

	it("covers agent-scoped entity joins with agent_id leading", () => {
		const index = componentSchema.indexes.idx_components_agent_entity;
		expect(index?.columns).toEqual([
			{ expression: "agent_id", isExpression: false },
			{ expression: "entity_id", isExpression: false },
		]);
		expect(index?.isUnique).toBe(false);
	});

	it("indexes world_id alone for world-scoped lookups", () => {
		const index = componentSchema.indexes.idx_components_world;
		expect(index?.columns).toEqual([
			{ expression: "world_id", isExpression: false },
		]);
		expect(index?.isUnique).toBe(false);
	});

	it("uses a GIN jsonb_path_ops expression index for data containment queries", () => {
		const index = componentSchema.indexes.idx_components_data_gin;
		expect(index?.method).toBe("gin");
		expect(index?.isUnique).toBe(false);
		expect(index?.columns).toEqual([
			{ expression: "data jsonb_path_ops", isExpression: true },
		]);
	});
});

describe("componentSchema foreign keys", () => {
	it("defines exactly five cascade deletes", () => {
		expect(Object.keys(componentSchema.foreignKeys)).toEqual([
			"fk_component_entity",
			"fk_component_agent",
			"fk_component_room",
			"fk_component_world",
			"fk_component_source_entity",
		]);
		for (const foreignKey of Object.values(componentSchema.foreignKeys)) {
			expect(foreignKey.onDelete).toBe("cascade");
		}
	});

	it("maps each owner column to its parent table's id", () => {
		expect(componentSchema.foreignKeys.fk_component_entity).toMatchObject({
			tableFrom: "components",
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
		});
		expect(
			componentSchema.foreignKeys.fk_component_source_entity,
		).toMatchObject({
			tableFrom: "components",
			tableTo: "entities",
			columnsFrom: ["source_entity_id"],
			columnsTo: ["id"],
		});
		expect(componentSchema.foreignKeys.fk_component_agent).toMatchObject({
			tableFrom: "components",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
		});
		expect(componentSchema.foreignKeys.fk_component_room).toMatchObject({
			tableFrom: "components",
			tableTo: "rooms",
			columnsFrom: ["room_id"],
			columnsTo: ["id"],
		});
		expect(componentSchema.foreignKeys.fk_component_world).toMatchObject({
			tableFrom: "components",
			tableTo: "worlds",
			columnsFrom: ["world_id"],
			columnsTo: ["id"],
		});
	});

	it("resolves every foreign key target in the default schema", () => {
		for (const foreignKey of Object.values(componentSchema.foreignKeys)) {
			expect(foreignKey.schemaTo).toBe("");
		}
	});
});

describe("componentSchema unique constraints", () => {
	it("treats NULLs as distinct-equal on the natural key so upserts stay idempotent", () => {
		const constraint =
			componentSchema.uniqueConstraints.unique_component_natural_key;
		expect(constraint).toBeDefined();
		expect(constraint?.columns).toEqual([
			"entity_id",
			"type",
			"world_id",
			"source_entity_id",
		]);
		expect(constraint?.nullsNotDistinct).toBe(true);
	});

	it("declares no check constraints", () => {
		expect(componentSchema.checkConstraints).toEqual({});
	});
});

describe("componentSchema internal consistency", () => {
	it("keys every index, foreign key, and constraint under its own name", () => {
		for (const [key, value] of Object.entries(componentSchema.indexes)) {
			expect(value.name).toBe(key);
		}
		for (const [key, value] of Object.entries(componentSchema.foreignKeys)) {
			expect(value.name).toBe(key);
		}
		for (const [key, value] of Object.entries(
			componentSchema.uniqueConstraints,
		)) {
			expect(value.name).toBe(key);
		}
	});

	it("references only declared columns from indexes and foreign keys", () => {
		const declaredColumns = new Set(Object.keys(componentSchema.columns));
		for (const index of Object.values(componentSchema.indexes)) {
			for (const column of index.columns) {
				if (!column.isExpression) {
					expect(declaredColumns.has(column.expression)).toBe(true);
				}
			}
		}
		for (const foreignKey of Object.values(componentSchema.foreignKeys)) {
			for (const columnName of foreignKey.columnsFrom) {
				expect(declaredColumns.has(columnName)).toBe(true);
			}
		}
		for (const constraint of Object.values(componentSchema.uniqueConstraints)) {
			for (const columnName of constraint.columns) {
				expect(declaredColumns.has(columnName)).toBe(true);
			}
		}
	});
});
