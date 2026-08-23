/**
 * Unit tests for the `logs` table descriptor (`logSchema`) the runtime writes
 * typed event records into and `getLogs` / `getAgentRunSummaries` read back.
 * Pure declarative-shape assertions over the real exported object — no mocks,
 * no DB: the descriptor itself is the contract adapters materialize. Covers
 * table identity, the full column set with nullability and defaults, the three
 * indexes including the covering index column order, both cascading foreign
 * keys, and the empty constraint maps.
 */
import { describe, expect, it } from "vitest";
import { logSchema } from "./log";

describe("logSchema table identity", () => {
	it("names the logs table in the default schema", () => {
		expect(logSchema.name).toBe("logs");
		expect(logSchema.schema).toBe("");
	});
});

describe("logSchema columns", () => {
	it("declares exactly the six log columns", () => {
		expect(Object.keys(logSchema.columns).sort()).toEqual([
			"body",
			"created_at",
			"entity_id",
			"id",
			"room_id",
			"type",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(logSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("types id as a non-null uuid defaulting to defaultRandom()", () => {
		expect(logSchema.columns.id).toEqual({
			name: "id",
			type: "uuid",
			notNull: true,
			default: "defaultRandom()",
		});
	});

	it("types created_at as a non-null timestamp defaulting to now()", () => {
		expect(logSchema.columns.created_at).toEqual({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("leaves entity_id, body, type, and room_id without defaults", () => {
		expect(logSchema.columns.entity_id.default).toBeUndefined();
		expect(logSchema.columns.body.default).toBeUndefined();
		expect(logSchema.columns.type.default).toBeUndefined();
		expect(logSchema.columns.room_id.default).toBeUndefined();
	});

	it("marks entity_id and room_id as non-null uuid scoping columns", () => {
		expect(logSchema.columns.entity_id.type).toBe("uuid");
		expect(logSchema.columns.entity_id.notNull).toBe(true);
		expect(logSchema.columns.room_id.type).toBe("uuid");
		expect(logSchema.columns.room_id.notNull).toBe(true);
	});

	it("stores body as non-null jsonb and type as non-null text", () => {
		expect(logSchema.columns.body.type).toBe("jsonb");
		expect(logSchema.columns.body.notNull).toBe(true);
		expect(logSchema.columns.type.type).toBe("text");
		expect(logSchema.columns.type.notNull).toBe(true);
	});
});

describe("logSchema indexes", () => {
	it("declares exactly three indexes", () => {
		expect(Object.keys(logSchema.indexes).sort()).toEqual([
			"idx_logs_entity_type",
			"idx_logs_room_type_created",
			"idx_logs_type",
		]);
	});

	it("covers getLogs filtering with room_id, type, created_at in order", () => {
		const index = logSchema.indexes.idx_logs_room_type_created;
		expect(index.name).toBe("idx_logs_room_type_created");
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"room_id",
			"type",
			"created_at",
		]);
		expect(index.columns.every((column) => column.isExpression === false)).toBe(
			true,
		);
	});

	it("supports the optional entity_id + type filter", () => {
		const index = logSchema.indexes.idx_logs_entity_type;
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"entity_id",
			"type",
		]);
	});

	it("supports agent-wide run aggregation by type alone", () => {
		const index = logSchema.indexes.idx_logs_type;
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual(["type"]);
	});

	it("references only columns that exist on the table", () => {
		for (const index of Object.values(logSchema.indexes)) {
			for (const column of index.columns) {
				expect(logSchema.columns[column.expression]).toBeDefined();
			}
		}
	});
});

describe("logSchema foreignKeys", () => {
	it("cascades room deletion through fk_room to rooms.id", () => {
		expect(logSchema.foreignKeys.fk_room).toEqual({
			name: "fk_room",
			tableFrom: "logs",
			tableTo: "rooms",
			columnsFrom: ["room_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("cascades entity deletion through fk_user to entities.id", () => {
		expect(logSchema.foreignKeys.fk_user).toEqual({
			name: "fk_user",
			tableFrom: "logs",
			tableTo: "entities",
			columnsFrom: ["entity_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("declares no foreign keys beyond the two cascade links", () => {
		expect(Object.keys(logSchema.foreignKeys).sort()).toEqual([
			"fk_room",
			"fk_user",
		]);
	});
});

describe("logSchema constraint maps", () => {
	it("uses the uuid default as implicit primary key — no composite keys", () => {
		expect(logSchema.compositePrimaryKeys).toEqual({});
	});

	it("declares no unique constraints or check constraints", () => {
		expect(logSchema.uniqueConstraints).toEqual({});
		expect(logSchema.checkConstraints).toEqual({});
	});
});
