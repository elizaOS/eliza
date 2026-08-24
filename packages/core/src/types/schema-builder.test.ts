/**
 * Tests for schema-builder — snakeToCamel helper.
 */
import { describe, expect, it } from "vitest";
import { snakeToCamel } from "./schema-builder.ts";

describe("schema-builder", () => {
	it("converts snake_case to camelCase", () => {
		expect(snakeToCamel("agent_id")).toBe("agentId");
		expect(snakeToCamel("created_at")).toBe("createdAt");
		expect(snakeToCamel("dim_384")).toBe("dim384");
	});

	it("handles single word", () => {
		expect(snakeToCamel("id")).toBe("id");
		expect(snakeToCamel("name")).toBe("name");
	});

	it("handles multiple underscores", () => {
		expect(snakeToCamel("my_long_column_name")).toBe("myLongColumnName");
	});

	it("handles leading/trailing underscores", () => {
		expect(snakeToCamel("_id")).toBe("Id");
		expect(snakeToCamel("id_")).toBe("id_");
	});

	it("handles empty string", () => {
		expect(snakeToCamel("")).toBe("");
	});

	it("handles numeric segments", () => {
		expect(snakeToCamel("dim_1024")).toBe("dim1024");
		expect(snakeToCamel("a_1_b_2")).toBe("a1B2");
	});
});
