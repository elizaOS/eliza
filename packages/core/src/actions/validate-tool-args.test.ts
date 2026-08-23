/**
 * Unit tests for tool argument schema validation and type coercion.
 */

import { describe, expect, it } from "vitest";
import type { Action } from "../types/index.js";
import {
	testSchemaPattern,
	validateSchema,
	validateToolArgs,
} from "./validate-tool-args.js";

describe("validate-tool-args", () => {
	describe("testSchemaPattern", () => {
		it("tests regex match successfully", () => {
			expect(testSchemaPattern("^[a-z]+$", "hello")).toEqual({ ok: true });
			expect(testSchemaPattern("^[a-z]+$", "123")).toEqual({
				ok: false,
				reason: "does not match pattern ^[a-z]+$",
			});
		});

		it("handles invalid regex pattern gracefully", () => {
			const result = testSchemaPattern("[invalid(", "test");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toContain("invalid pattern");
			}
		});

		it("rejects strings exceeding MAX_PATTERN_INPUT_LENGTH", () => {
			const hugeString = "a".repeat(50_001);
			const result = testSchemaPattern("^[a-z]+$", hugeString);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toContain("too long to validate");
			}
		});
	});

	describe("validateSchema", () => {
		it("validates strings, minLength, maxLength, and enums", () => {
			const errors: string[] = [];
			const schema = {
				type: "string" as const,
				minLength: 2,
				maxLength: 10,
				enum: ["alice", "bob"],
			};

			const valid = validateSchema(schema, "alice", "username", errors);
			expect(valid).toBe("alice");
			expect(errors).toHaveLength(0);

			// Trims whitespace for enum match
			const trimmedEnum = validateSchema(schema, " bob ", "username", errors);
			expect(trimmedEnum).toBe("bob");
			expect(errors).toHaveLength(0);

			// Type mismatch
			validateSchema(schema, 123, "username", errors);
			expect(errors).toContain(
				"Argument 'username' expected string, got number",
			);
		});

		it("validates numbers, integers, and bounds", () => {
			const errors: string[] = [];
			const numSchema = {
				type: "number" as const,
				minimum: 10,
				maximum: 100,
			};

			validateSchema(numSchema, 50, "score", errors);
			expect(errors).toHaveLength(0);

			validateSchema(numSchema, 5, "score", errors);
			expect(errors).toContain("Argument 'score' value 5 is below minimum 10");

			validateSchema(numSchema, 150, "score", errors);
			expect(errors).toContain(
				"Argument 'score' value 150 is above maximum 100",
			);

			const intSchema = { type: "integer" as const };
			validateSchema(intSchema, 3.14, "count", errors);
			expect(errors).toContain("Argument 'count' expected integer, got number");
		});

		it("validates arrays and objects with nested defaults", () => {
			const errors: string[] = [];
			const objSchema = {
				type: "object" as const,
				required: ["id"],
				properties: {
					id: { type: "string" as const },
					enabled: { type: "boolean" as const, default: true },
				},
			};

			const result = validateSchema(
				objSchema,
				{ id: "item-1" },
				"item",
				errors,
			);
			expect(errors).toHaveLength(0);
			expect(result).toEqual({ id: "item-1", enabled: true });
		});
	});

	describe("validateToolArgs", () => {
		it("validates action tool arguments against action parameter schema", () => {
			const action: Action = {
				name: "TEST_ACTION",
				description: "Test action",
				parameters: [
					{
						name: "query",
						description: "Search query",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "limit",
						description: "Result limit",
						required: false,
						schema: { type: "number", default: 10 },
					},
				],
				handler: async () => undefined,
				validate: async () => true,
				examples: [],
			};

			// Valid args
			const validResult = validateToolArgs(action, { query: "elizaOS" });
			expect(validResult.valid).toBe(true);
			expect(validResult.args).toEqual({ query: "elizaOS", limit: 10 });
			expect(validResult.errors).toHaveLength(0);

			// Missing required arg
			const invalidResult = validateToolArgs(action, {});
			expect(invalidResult.valid).toBe(false);
			expect(invalidResult.errors).toContain(
				"Missing required argument 'query'",
			);

			// Non-object args
			const nonObjResult = validateToolArgs(action, "string-arg");
			expect(nonObjResult.valid).toBe(false);
			expect(nonObjResult.errors[0]).toContain("must be an object");
		});
	});
});
