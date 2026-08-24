/**
 * Verifies the portable `message_servers` table descriptor keeps the
 * find-or-create keying contract: deterministic self-named columns, a
 * non-unique (source_type, source_id) lookup index, server-local defaults,
 * and no relational escape hatches. Pure data assertions against the real
 * exported descriptor — no mocks.
 */

import { describe, expect, it } from "vitest";
import { messageServerSchema } from "./message-server";

describe("message_servers table descriptor", () => {
	it("keeps the portable table identity and find-or-create lookup index", () => {
		expect(messageServerSchema.name).toBe("message_servers");
		expect(messageServerSchema.schema).toBe("");
		const lookup = messageServerSchema.indexes.idx_ms_source;
		expect(lookup?.name).toBe("idx_ms_source");
		expect(lookup?.isUnique).toBe(false);
		expect(lookup?.columns).toEqual([
			{ expression: "source_type", isExpression: false },
			{ expression: "source_id", isExpression: false },
		]);
	});

	it("declares the complete column contract with explicit nullability", () => {
		const { columns } = messageServerSchema;
		expect(columns.id).toMatchObject({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
		});
		expect(columns.name).toMatchObject({ type: "text", notNull: true });
		expect(columns.source_type).toMatchObject({
			type: "text",
			notNull: true,
		});
		expect(columns.source_id?.notNull).toBeUndefined();
		expect(columns.metadata).toMatchObject({ type: "jsonb" });
		expect(columns.metadata?.notNull).toBeUndefined();
	});

	it("defaults both audit timestamps to now() and requires them", () => {
		for (const key of ["created_at", "updated_at"] as const) {
			const column = messageServerSchema.columns[key];
			expect(column?.type).toBe("timestamp");
			expect(column?.notNull).toBe(true);
			expect(column?.default).toBe("now()");
		}
	});

	it("mirrors every column key into its declared name", () => {
		for (const [key, column] of Object.entries(messageServerSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});

	it("stays a standalone container with no relations or extra constraints", () => {
		expect(messageServerSchema.foreignKeys).toEqual({});
		expect(messageServerSchema.compositePrimaryKeys).toEqual({});
		expect(messageServerSchema.uniqueConstraints).toEqual({});
		expect(messageServerSchema.checkConstraints).toEqual({});
	});
});
