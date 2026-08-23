/**
 * Unit tests for the `rooms` table descriptor (`roomSchema`) that scopes every
 * conversation context under an agent, world, and message-server. Pure
 * declarative-shape assertions over the real exported object — no mocks, no
 * DB: the descriptor itself is the contract adapters materialize. Covers
 * table identity, the full column set with nullability and defaults including
 * the explicit primary key, both agent/world lookup indexes with their column
 * order, the single cascading foreign key to agents, and the empty constraint
 * maps.
 */
import { describe, expect, it } from "vitest";
import { roomSchema } from "./room";

describe("roomSchema table identity", () => {
	it("names the rooms table in the default schema", () => {
		expect(roomSchema.name).toBe("rooms");
		expect(roomSchema.schema).toBe("");
	});
});

describe("roomSchema columns", () => {
	it("declares exactly the ten room columns", () => {
		expect(Object.keys(roomSchema.columns).sort()).toEqual([
			"agent_id",
			"channel_id",
			"created_at",
			"id",
			"message_server_id",
			"metadata",
			"name",
			"source",
			"type",
			"world_id",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(roomSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("types id as the primary key: non-null uuid defaulting to gen_random_uuid()", () => {
		expect(roomSchema.columns.id).toEqual({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "gen_random_uuid()",
		});
	});

	it("types created_at as a non-null timestamp defaulting to now()", () => {
		expect(roomSchema.columns.created_at).toEqual({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("marks source and type as required non-null text business columns without defaults", () => {
		for (const key of ["source", "type"] as const) {
			const column = roomSchema.columns[key];
			expect(column.type).toBe("text");
			expect(column.notNull).toBe(true);
			expect(column.default).toBeUndefined();
		}
	});

	it("leaves agent_id, message_server_id, and world_id as optional uuid scoping columns", () => {
		for (const key of ["agent_id", "message_server_id", "world_id"] as const) {
			const column = roomSchema.columns[key];
			expect(column.type).toBe("uuid");
			expect(column.notNull).toBeUndefined();
			expect(column.default).toBeUndefined();
			expect(column.primaryKey).toBeUndefined();
		}
	});

	it("stores name and channel_id as optional text and metadata as optional jsonb", () => {
		expect(roomSchema.columns.name).toEqual({ name: "name", type: "text" });
		expect(roomSchema.columns.channel_id).toEqual({
			name: "channel_id",
			type: "text",
		});
		expect(roomSchema.columns.metadata).toEqual({
			name: "metadata",
			type: "jsonb",
		});
	});
});

describe("roomSchema indexes", () => {
	it("declares exactly the two lookup indexes", () => {
		expect(Object.keys(roomSchema.indexes).sort()).toEqual([
			"idx_rooms_agent",
			"idx_rooms_world",
		]);
	});

	it("supports agent-scoped room queries through idx_rooms_agent", () => {
		const index = roomSchema.indexes.idx_rooms_agent;
		expect(index.name).toBe("idx_rooms_agent");
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"agent_id",
		]);
		expect(index.columns.every((column) => column.isExpression === false)).toBe(
			true,
		);
	});

	it("supports world-scoped room lookups through idx_rooms_world", () => {
		const index = roomSchema.indexes.idx_rooms_world;
		expect(index.name).toBe("idx_rooms_world");
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"world_id",
		]);
		expect(index.columns.every((column) => column.isExpression === false)).toBe(
			true,
		);
	});

	it("references only columns that exist on the table", () => {
		for (const index of Object.values(roomSchema.indexes)) {
			for (const column of index.columns) {
				expect(roomSchema.columns[column.expression]).toBeDefined();
			}
		}
	});
});

describe("roomSchema foreignKeys", () => {
	it("cascades agent deletion through fk_room_agent to agents.id", () => {
		expect(roomSchema.foreignKeys.fk_room_agent).toEqual({
			name: "fk_room_agent",
			tableFrom: "rooms",
			tableTo: "agents",
			columnsFrom: ["agent_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("declares no foreign keys beyond the agent cascade link", () => {
		expect(Object.keys(roomSchema.foreignKeys).sort()).toEqual([
			"fk_room_agent",
		]);
	});
});

describe("roomSchema constraint maps", () => {
	it("uses the explicit id primary key — no composite keys", () => {
		expect(roomSchema.compositePrimaryKeys).toEqual({});
	});

	it("declares no unique constraints or check constraints", () => {
		expect(roomSchema.uniqueConstraints).toEqual({});
		expect(roomSchema.checkConstraints).toEqual({});
	});
});
