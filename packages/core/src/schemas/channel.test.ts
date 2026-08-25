/**
 * Unit tests for the `channels` table descriptor (`channelSchema`) — messaging
 * channels scoped to a message_server, with text (not native uuid) ids. Pure
 * declarative-shape assertions over the real exported object — no mocks, no
 * DB: the descriptor itself is the contract adapters materialize. Covers table
 * identity, the full column set with nullability and defaults, both lookup
 * indexes with their column order, the cascading message_server foreign key,
 * and the empty constraint maps.
 */
import { describe, expect, it } from "vitest";
import { channelSchema } from "./channel";

describe("channelSchema table identity", () => {
	it("names the channels table in the default schema", () => {
		expect(channelSchema.name).toBe("channels");
		expect(channelSchema.schema).toBe("");
	});
});

describe("channelSchema columns", () => {
	it("declares exactly the ten channel columns", () => {
		expect(Object.keys(channelSchema.columns).sort()).toEqual([
			"created_at",
			"id",
			"message_server_id",
			"metadata",
			"name",
			"source_id",
			"source_type",
			"topic",
			"type",
			"updated_at",
		]);
	});

	it("keeps every column key consistent with its own name field", () => {
		for (const [key, column] of Object.entries(channelSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("types id as the primary key: non-null text without a default", () => {
		expect(channelSchema.columns.id).toEqual({
			name: "id",
			type: "text",
			primaryKey: true,
			notNull: true,
		});
	});

	it("types message_server_id as a required non-null uuid scoping column", () => {
		expect(channelSchema.columns.message_server_id).toEqual({
			name: "message_server_id",
			type: "uuid",
			notNull: true,
		});
	});

	it("marks name and type as required non-null text business columns without defaults", () => {
		for (const key of ["name", "type"] as const) {
			const column = channelSchema.columns[key];
			expect(column.type).toBe("text");
			expect(column.notNull).toBe(true);
			expect(column.default).toBeUndefined();
		}
	});

	it("leaves source_type, source_id, topic, and metadata as optional columns", () => {
		for (const key of [
			"source_type",
			"source_id",
			"topic",
			"metadata",
		] as const) {
			const column = channelSchema.columns[key];
			expect(column.notNull).toBeUndefined();
			expect(column.default).toBeUndefined();
			expect(column.primaryKey).toBeUndefined();
		}
	});

	it("types created_at and updated_at as non-null timestamps defaulting to now()", () => {
		for (const key of ["created_at", "updated_at"] as const) {
			expect(channelSchema.columns[key]).toEqual({
				name: key,
				type: "timestamp",
				notNull: true,
				default: "now()",
			});
		}
	});

	it("marks exactly id as the primary key", () => {
		for (const [key, column] of Object.entries(channelSchema.columns)) {
			if (key === "id") {
				expect(column.primaryKey).toBe(true);
			} else {
				expect(column.primaryKey).toBeUndefined();
			}
		}
	});
});

describe("channelSchema indexes", () => {
	it("declares exactly the server and type/name/server lookup indexes", () => {
		expect(Object.keys(channelSchema.indexes).sort()).toEqual([
			"idx_channels_server",
			"idx_channels_type_name_server",
		]);
	});

	it("indexes message_server_id for channel lookups, non-unique", () => {
		const index = channelSchema.indexes.idx_channels_server;
		expect(index.name).toBe("idx_channels_server");
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"message_server_id",
		]);
		expect(index.columns.every((column) => column.isExpression === false)).toBe(
			true,
		);
	});

	it("keeps type/name/message_server_id column order in the composite DM lookup index", () => {
		const index = channelSchema.indexes.idx_channels_type_name_server;
		expect(index.name).toBe("idx_channels_type_name_server");
		expect(index.isUnique).toBe(false);
		expect(index.columns.map((column) => column.expression)).toEqual([
			"type",
			"name",
			"message_server_id",
		]);
		expect(index.columns.every((column) => column.isExpression === false)).toBe(
			true,
		);
	});

	it("references only columns that exist on the table", () => {
		for (const index of Object.values(channelSchema.indexes)) {
			for (const column of index.columns) {
				expect(channelSchema.columns[column.expression]).toBeDefined();
			}
		}
	});
});

describe("channelSchema foreignKeys", () => {
	it("cascades message_server deletion through fk_channel_message_server", () => {
		expect(channelSchema.foreignKeys.fk_channel_message_server).toEqual({
			name: "fk_channel_message_server",
			tableFrom: "channels",
			tableTo: "message_servers",
			columnsFrom: ["message_server_id"],
			columnsTo: ["id"],
			onDelete: "cascade",
			schemaTo: "",
		});
	});

	it("declares no foreign keys beyond the message_server cascade link", () => {
		expect(Object.keys(channelSchema.foreignKeys).sort()).toEqual([
			"fk_channel_message_server",
		]);
	});
});

describe("channelSchema constraint maps", () => {
	it("uses the explicit id primary key — no composite keys", () => {
		expect(channelSchema.compositePrimaryKeys).toEqual({});
	});

	it("declares no unique constraints or check constraints", () => {
		expect(channelSchema.uniqueConstraints).toEqual({});
		expect(channelSchema.checkConstraints).toEqual({});
	});
});
