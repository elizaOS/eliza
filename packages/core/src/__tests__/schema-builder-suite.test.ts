/**
 * Unit tests for schema builder dialect utilities.
 * Validates snake_case to camelCase conversion for table column identifiers.
 */
import { describe, expect, it } from "vitest";
import { snakeToCamel } from "../types/schema-builder.ts";

describe("schema-builder", () => {
	describe("snakeToCamel", () => {
		it("converts simple snake_case strings to camelCase", () => {
			expect(snakeToCamel("agent_id")).toBe("agentId");
			expect(snakeToCamel("created_at")).toBe("createdAt");
			expect(snakeToCamel("user_first_name")).toBe("userFirstName");
		});

		it("handles alphanumeric tokens with numbers correctly", () => {
			expect(snakeToCamel("dim_384")).toBe("dim384");
			expect(snakeToCamel("field_1_value")).toBe("field1Value");
		});

		it("leaves strings without underscores unchanged", () => {
			expect(snakeToCamel("alreadyCamel")).toBe("alreadyCamel");
			expect(snakeToCamel("name")).toBe("name");
			expect(snakeToCamel("")).toBe("");
		});
	});
});
