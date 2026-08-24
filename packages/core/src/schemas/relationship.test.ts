/**
 * Unit tests for the `relationships` table definition (`relationshipSchema`) —
 * the directed, agent-scoped edge schema the relationships service reads and
 * writes and SQL adapters materialize. Pure data-object assertions over the
 * exported `SchemaTable`; deterministic, no database, no mocks.
 */
import { describe, expect, it } from "vitest";
import { relationshipSchema } from "./relationship";

describe("relationshipSchema table identity", () => {
	it("is the relationships table in the default schema", () => {
		expect(relationshipSchema.name).toBe("relationships");
		expect(relationshipSchema.schema).toBe("");
	});

	it("exposes exactly the seven edge columns in declaration order", () => {
		expect(Object.keys(relationshipSchema.columns)).toEqual([
			"id",
			"created_at",
			"source_entity_id",
			"target_entity_id",
			"agent_id",
			"tags",
			"metadata",
		]);
	});

	it("mirrors every column key into its own name field", () => {
		for (const [key, column] of Object.entries(relationshipSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});
});

describe("relationshipSchema columns", () => {
	it("makes id the sole primary key with a server-generated uuid default", () => {
		const primaryKeys = Object.entries(relationshipSchema.columns).filter(
			([, column]) => column.primaryKey,
		);
		expect(primaryKeys.map(([key]) => key)).toEqual(["id"]);
		expect(relationshipSchema.columns.id).toMatchObject({
			type: "uuid",
			notNull: true,
			default: "gen_random_uuid()",
		});
	});

	it("stamps created_at server-side", () => {
		expect(relationshipSchema.columns.created_at).toMatchObject({
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("requires both endpoints and the owning agent as uuids", () => {
		for (const key of [
			"source_entity_id",
			"target_entity_id",
			"agent_id",
		] as const) {
			expect(relationshipSchema.columns[key]).toMatchObject({
				type: "uuid",
				notNull: true,
			});
			expect(relationshipSchema.columns[key].primaryKey).toBeUndefined();
		}
	});

	it("keeps tags and metadata as nullable free-form payloads", () => {
		expect(relationshipSchema.columns.tags?.type).toBe("text[]");
		expect(relationshipSchema.columns.tags?.notNull).toBeUndefined();
		expect(relationshipSchema.columns.metadata?.type).toBe("jsonb");
		expect(relationshipSchema.columns.metadata?.notNull).toBeUndefined();
	});
});

describe("relationshipSchema indexes", () => {
	it("declares exactly the pair-lookup and reverse-target indexes, neither unique", () => {
		expect(Object.keys(relationshipSchema.indexes)).toEqual([
			"idx_relationships_users",
			"idx_relationships_target",
		]);
		for (const index of Object.values(relationshipSchema.indexes)) {
			expect(index.isUnique).toBe(false);
		}
	});

	it("orders idx_relationships_users source-first then target", () => {
		const users = relationshipSchema.indexes.idx_relationships_users;
		expect(users.name).toBe("idx_relationships_users");
		expect(
			users.columns.map((column) => ({
				expression: column.expression,
				isExpression: column.isExpression,
			})),
		).toEqual([
			{ expression: "source_entity_id", isExpression: false },
			{ expression: "target_entity_id", isExpression: false },
		]);
	});

	it("gives target-only lookups their own single-column index", () => {
		const target = relationshipSchema.indexes.idx_relationships_target;
		expect(target.name).toBe("idx_relationships_target");
		expect(target.columns.map((column) => column.expression)).toEqual([
			"target_entity_id",
		]);
		expect(target.columns[0]?.isExpression).toBe(false);
	});
});

describe("relationshipSchema foreignKeys", () => {
	it("cascades deletion from each entity endpoint to its own column", () => {
		expect(relationshipSchema.foreignKeys.fk_user_a).toMatchObject({
			tableFrom: "relationships",
			tableTo: "entities",
			onDelete: "cascade",
			schemaTo: "",
			columnsFrom: ["source_entity_id"],
			columnsTo: ["id"],
		});
		expect(relationshipSchema.foreignKeys.fk_user_b).toMatchObject({
			tableFrom: "relationships",
			tableTo: "entities",
			onDelete: "cascade",
			schemaTo: "",
			columnsFrom: ["target_entity_id"],
			columnsTo: ["id"],
		});
	});

	it("binds the edge to its owning agent by cascade", () => {
		expect(relationshipSchema.foreignKeys.fk_relationship_agent).toMatchObject({
			tableFrom: "relationships",
			tableTo: "agents",
			onDelete: "cascade",
			schemaTo: "",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
		});
	});
});

describe("relationshipSchema uniqueConstraints", () => {
	it("enforces one edge per (source, target, agent) triple", () => {
		expect(Object.keys(relationshipSchema.uniqueConstraints)).toEqual([
			"unique_relationship",
		]);
		expect(relationshipSchema.uniqueConstraints.unique_relationship).toEqual({
			name: "unique_relationship",
			columns: ["source_entity_id", "target_entity_id", "agent_id"],
		});
	});

	it("constrains only required endpoint columns", () => {
		const unique =
			relationshipSchema.uniqueConstraints.unique_relationship.columns;
		for (const column of unique) {
			expect(relationshipSchema.columns[column]?.notNull).toBe(true);
		}
	});
});
