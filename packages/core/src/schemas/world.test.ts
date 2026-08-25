/**
 * Unit tests for the `worlds` table descriptor (`worldSchema`) that groups
 * rooms under agent-owned server/guild worlds. Pure declarative-shape
 * assertions over the real exported object — no mocks, no DB: the descriptor
 * itself is the contract adapters materialize. Covers table identity, the
 * full column set with nullability and defaults, the agent-scoping index,
 * the cascading agent foreign key, and the empty constraint maps.
 */
import { describe, expect, it } from "vitest";
import { worldSchema } from "./world";

describe("worldSchema table identity", () => {
	it("names the worlds table in the default schema", () => {
		expect(worldSchema.name).toBe("worlds");
		expect(worldSchema.schema).toBe("");
	});
});

describe("worldSchema columns", () => {
	it("declares exactly the six world columns", () => {
		expect(Object.keys(worldSchema.columns).sort()).toEqual([
			"agent_id",
			"created_at",
			"id",
			"message_server_id",
			"metadata",
			"name",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(worldSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("types id as a non-null primary-key uuid defaulting to gen_random_uuid()", () => {
		expect(worldSchema.columns.id).toEqual({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		});
	});

	it("types created_at as a non-null timestamp defaulting to now()", () => {
		expect(worldSchema.columns.created_at).toEqual({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("marks agent_id as a non-null uuid without a default", () => {
		expect(worldSchema.columns.agent_id.type).toBe("uuid");
		expect(worldSchema.columns.agent_id.notNull).toBe(true);
		expect(worldSchema.columns.agent_id.default).toBeUndefined();
	});

	it("marks name as non-null text without a default", () => {
		expect(worldSchema.columns.name.type).toBe("text");
		expect(worldSchema.columns.name.notNull).toBe(true);
		expect(worldSchema.columns.name.default).toBeUndefined();
	});

	it("leaves metadata jsonb and message_server_id uuid nullable", () => {
		expect(worldSchema.columns.metadata.type).toBe("jsonb");
		expect(worldSchema.columns.metadata.notNull).toBeUndefined();
		expect(worldSchema.columns.message_server_id.type).toBe("uuid");
		expect(worldSchema.columns.message_server_id.notNull).toBeUndefined();
	});

	it("declares no defaults beyond id and created_at", () => {
		for (const [key, column] of Object.entries(worldSchema.columns)) {
			if (key !== "id" && key !== "created_at") {
				expect(column.default).toBeUndefined();
			}
		}
	});
});

describe("worldSchema indexes", () => {
	it("declares exactly one index", () => {
		expect(Object.keys(worldSchema.indexes)).toEqual(["idx_worlds_agent"]);
	});

	it("covers getWorlds agent filtering with a plain single-column agent_id index", () => {
		const index = worldSchema.indexes.idx_worlds_agent;
		expect(index.name).toBe("idx_worlds_agent");
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"agent_id",
		]);
		expect(index.columns.every((column) => column.isExpression === false)).toBe(
			true,
		);
	});

	it("references only columns that exist on the table", () => {
		for (const index of Object.values(worldSchema.indexes)) {
			for (const column of index.columns) {
				expect(worldSchema.columns[column.expression]).toBeDefined();
			}
		}
	});
});

describe("worldSchema foreignKeys", () => {
	it("cascades agent deletion through fk_world_agent to agents.id", () => {
		expect(worldSchema.foreignKeys.fk_world_agent).toEqual({
			name: "fk_world_agent",
			tableFrom: "worlds",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("declares no foreign keys beyond the agent cascade link", () => {
		expect(Object.keys(worldSchema.foreignKeys)).toEqual(["fk_world_agent"]);
	});
});

describe("worldSchema constraint maps", () => {
	it("uses the explicit uuid primary key — no composite keys", () => {
		expect(worldSchema.compositePrimaryKeys).toEqual({});
	});

	it("declares no unique constraints or check constraints", () => {
		expect(worldSchema.uniqueConstraints).toEqual({});
		expect(worldSchema.checkConstraints).toEqual({});
	});
});
