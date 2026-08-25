/**
 * Unit tests for the `entities` table descriptor (`entitySchema`) — the
 * per-agent record of people and things an agent knows, keyed uniquely by
 * (id, agent_id). Pure declarative-shape assertions over the real exported
 * object — no mocks, no DB: the descriptor itself is the contract adapters
 * materialize. Covers table identity, the full column set with nullability and
 * defaults, the agent_id lookup index, the cascading agent foreign key, and
 * the (id, agent_id) unique constraint.
 */
import { describe, expect, it } from "vitest";
import { entitySchema } from "./entity";

describe("entitySchema table identity", () => {
	it("names the entities table in the default schema", () => {
		expect(entitySchema.name).toBe("entities");
		expect(entitySchema.schema).toBe("");
	});
});

describe("entitySchema columns", () => {
	it("declares exactly the five entity columns", () => {
		expect(Object.keys(entitySchema.columns).sort()).toEqual([
			"agent_id",
			"created_at",
			"id",
			"metadata",
			"names",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(entitySchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("types id as the primary key: non-null uuid without a default", () => {
		expect(entitySchema.columns.id).toEqual({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		});
	});

	it("types agent_id as a required non-null uuid scoping column", () => {
		expect(entitySchema.columns.agent_id).toEqual({
			name: "agent_id",
			type: "uuid",
			notNull: true,
		});
	});

	it("types created_at as a non-null timestamp defaulting to now()", () => {
		expect(entitySchema.columns.created_at).toEqual({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("types names as a non-null text[] defaulting to an empty array", () => {
		expect(entitySchema.columns.names).toEqual({
			name: "names",
			type: "text[]",
			notNull: true,
			default: "[]",
		});
	});

	it("types metadata as a non-null jsonb defaulting to an empty object", () => {
		expect(entitySchema.columns.metadata).toEqual({
			name: "metadata",
			type: "jsonb",
			notNull: true,
			default: "{}",
		});
	});

	it("marks exactly id as the primary key", () => {
		for (const [key, column] of Object.entries(entitySchema.columns)) {
			if (key === "id") {
				expect(column.primaryKey).toBe(true);
			} else {
				expect(column.primaryKey).toBeUndefined();
			}
		}
	});
});

describe("entitySchema indexes", () => {
	it("declares exactly the agent_id lookup index", () => {
		expect(Object.keys(entitySchema.indexes).sort()).toEqual([
			"idx_entities_agent",
		]);
	});

	it("indexes agent_id for entity lookups, non-unique", () => {
		const index = entitySchema.indexes.idx_entities_agent;
		expect(index.name).toBe("idx_entities_agent");
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"agent_id",
		]);
		expect(index.columns.every((column) => column.isExpression === false)).toBe(
			true,
		);
	});

	it("references only columns that exist on the table", () => {
		for (const index of Object.values(entitySchema.indexes)) {
			for (const column of index.columns) {
				expect(entitySchema.columns[column.expression]).toBeDefined();
			}
		}
	});
});

describe("entitySchema foreignKeys", () => {
	it("cascades agent deletion through fk_entity_agent to agents.id", () => {
		expect(entitySchema.foreignKeys.fk_entity_agent).toEqual({
			name: "fk_entity_agent",
			tableFrom: "entities",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("declares no foreign keys beyond the agent cascade link", () => {
		expect(Object.keys(entitySchema.foreignKeys).sort()).toEqual([
			"fk_entity_agent",
		]);
	});
});

describe("entitySchema constraint maps", () => {
	it("uses the explicit id primary key — no composite keys", () => {
		expect(entitySchema.compositePrimaryKeys).toEqual({});
	});

	it("declares the (id, agent_id) unique constraint", () => {
		expect(entitySchema.uniqueConstraints).toEqual({
			id_agent_id_unique: {
				name: "id_agent_id_unique",
				columns: ["id", "agent_id"],
			},
		});
	});

	it("declares no check constraints", () => {
		expect(entitySchema.checkConstraints).toEqual({});
	});
});
