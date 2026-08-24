/**
 * Verifies the canonical `channels` table descriptor keeps its storage
 * contract: text (not native uuid) primary ids, message_server scoping via a
 * non-unique lookup index plus the composite DM-lookup index, and cascade
 * delete through the owning foreign key. Pure data assertions against the
 * real exported descriptor — no mocks.
 */

import { describe, expect, it } from "vitest";
import { channelSchema } from "./channel";

describe("channels table descriptor", () => {
	it("keeps the table identity and both scoping indexes", () => {
		expect(channelSchema.name).toBe("channels");
		expect(channelSchema.schema).toBe("");

		const serverIndex = channelSchema.indexes.idx_channels_server;
		expect(serverIndex?.name).toBe("idx_channels_server");
		expect(serverIndex?.isUnique).toBe(false);
		expect(serverIndex?.columns).toEqual([
			{ expression: "message_server_id", isExpression: false },
		]);

		const dmLookup = channelSchema.indexes.idx_channels_type_name_server;
		expect(dmLookup?.name).toBe("idx_channels_type_name_server");
		expect(dmLookup?.isUnique).toBe(false);
		expect(dmLookup?.columns).toEqual([
			{ expression: "type", isExpression: false },
			{ expression: "name", isExpression: false },
			{ expression: "message_server_id", isExpression: false },
		]);
	});

	it("stores id as a text primary key rather than a native uuid", () => {
		expect(channelSchema.columns.id).toMatchObject({
			name: "id",
			type: "text",
			primaryKey: true,
			notNull: true,
		});
	});

	it("declares the complete column contract with explicit nullability", () => {
		const { columns } = channelSchema;
		expect(Object.keys(columns)).toEqual([
			"id",
			"message_server_id",
			"name",
			"type",
			"source_type",
			"source_id",
			"topic",
			"metadata",
			"created_at",
			"updated_at",
		]);
		expect(columns.message_server_id).toMatchObject({
			type: "uuid",
			notNull: true,
		});
		expect(columns.name).toMatchObject({ type: "text", notNull: true });
		expect(columns.type).toMatchObject({ type: "text", notNull: true });
		for (const key of ["source_type", "source_id", "topic"] as const) {
			expect(columns[key]).toMatchObject({ type: "text" });
			expect(columns[key]?.notNull).toBeUndefined();
		}
		expect(columns.metadata).toMatchObject({ type: "jsonb" });
		expect(columns.metadata?.notNull).toBeUndefined();
	});

	it("defaults both audit timestamps to now() and requires them", () => {
		for (const key of ["created_at", "updated_at"] as const) {
			const column = channelSchema.columns[key];
			expect(column?.type).toBe("timestamp");
			expect(column?.notNull).toBe(true);
			expect(column?.default).toBe("now()");
		}
	});

	it("mirrors every column key into its declared name", () => {
		for (const [key, column] of Object.entries(channelSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("cascades deletes from the owning message server", () => {
		const fk = channelSchema.foreignKeys.fk_channel_message_server;
		expect(fk?.name).toBe("fk_channel_message_server");
		expect(fk?.tableFrom).toBe("channels");
		expect(fk?.tableTo).toBe("message_servers");
		expect(fk?.columnsFrom).toEqual(["message_server_id"]);
		expect(fk?.columnsTo).toEqual(["id"]);
		expect(fk?.onDelete).toBe("cascade");
		expect(fk?.schemaTo).toBe("");
	});

	it("carries no composite keys or extra constraints", () => {
		expect(channelSchema.compositePrimaryKeys).toEqual({});
		expect(channelSchema.uniqueConstraints).toEqual({});
		expect(channelSchema.checkConstraints).toEqual({});
	});
});
