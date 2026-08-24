import { describe, expect, it } from "vitest";
import { agentSchema } from "../schemas/agent.ts";
import type { SchemaTable } from "../types/schema.ts";

describe("agentSchema", () => {
	it("declares the canonical agents table name", () => {
		expect(agentSchema.name).toBe("agents");
	});

	it("satisfies the SchemaTable contract", () => {
		const table: SchemaTable = agentSchema;
		expect(table).toBeDefined();
	});

	it("declares id as a non-null uuid primary key with defaultRandom", () => {
		expect(agentSchema.columns.id).toMatchObject({
			name: "id",
			type: "uuid",
			primaryKey: true,
			notNull: true,
			default: "defaultRandom()",
		});
	});

	it("declares enabled as a non-null boolean defaulting to true", () => {
		expect(agentSchema.columns.enabled).toMatchObject({
			name: "enabled",
			type: "boolean",
			notNull: true,
			default: true,
		});
	});

	it("declares created_at and updated_at as non-null timestamps defaulting to now()", () => {
		expect(agentSchema.columns.created_at).toMatchObject({
			name: "created_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
		expect(agentSchema.columns.updated_at).toMatchObject({
			name: "updated_at",
			type: "timestamp",
			notNull: true,
			default: "now()",
		});
	});

	it("declares name as non-null text and username as nullable text", () => {
		expect(agentSchema.columns.name).toMatchObject({
			name: "name",
			type: "text",
			notNull: true,
		});
		expect(agentSchema.columns.username).toMatchObject({
			name: "username",
			type: "text",
		});
		expect(agentSchema.columns.username.notNull).toBeFalsy();
	});

	it("defaults every jsonb list column to an empty array", () => {
		for (const col of [
			"bio",
			"message_examples",
			"post_examples",
			"topics",
			"adjectives",
			"documents",
			"plugins",
		]) {
			expect(agentSchema.columns[col]).toMatchObject({
				type: "jsonb",
				notNull: true,
				default: "[]",
			});
		}
	});

	it("defaults settings and style jsonb columns to an empty object", () => {
		expect(agentSchema.columns.settings).toMatchObject({
			type: "jsonb",
			notNull: true,
			default: "{}",
		});
		expect(agentSchema.columns.style).toMatchObject({
			type: "jsonb",
			notNull: true,
			default: "{}",
		});
	});

	it("declares no foreign keys or composite keys on the root table", () => {
		expect(Object.keys(agentSchema.foreignKeys)).toHaveLength(0);
		expect(Object.keys(agentSchema.compositePrimaryKeys)).toHaveLength(0);
		expect(Object.keys(agentSchema.uniqueConstraints)).toHaveLength(0);
	});

	it("keeps every declared column in the columns map", () => {
		const columnNames = Object.values(agentSchema.columns).map((c) => c.name);
		expect(columnNames).toEqual(
			expect.arrayContaining([
				"id",
				"enabled",
				"server_id",
				"created_at",
				"updated_at",
				"name",
				"username",
				"system",
			]),
		);
		for (const [key, column] of Object.entries(agentSchema.columns)) {
			expect(column.name).toBe(key);
		}
	});
});
