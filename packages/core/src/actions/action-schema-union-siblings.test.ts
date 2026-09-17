import { describe, expect, it } from "vitest";
import type { ActionParameterSchema } from "../types";
import {
	actionParameterSchemaToJsonSchema,
	normalizeActionJsonSchema,
} from "./action-schema";
import { validateSchema } from "./validate-tool-args";

describe("action union sibling constraints", () => {
	const filter: ActionParameterSchema = {
		type: "object",
		properties: {
			mode: { type: "string", enum: ["all", "literal"] },
			text: { type: "string", minLength: 1 },
		},
		required: ["mode"],
		additionalProperties: false,
		anyOf: [
			{
				type: "object",
				properties: { mode: { type: "string", enum: ["all"] } },
				required: ["mode"],
			},
			{
				type: "object",
				properties: {
					mode: { type: "string", enum: ["literal"] },
					text: { type: "string" },
				},
				required: ["mode", "text"],
			},
		],
	};

	it("keeps an explicitly typed object union intact in the model schema", () => {
		const normalized = normalizeActionJsonSchema({
			parameters: [
				{
					name: "filter",
					description: "Search filter",
					required: true,
					schema: filter,
				},
			],
		});
		expect(normalized.properties?.filter).toMatchObject({
			type: "object",
			required: ["mode"],
			additionalProperties: false,
			properties: { text: { type: "string", minLength: 1 } },
			anyOf: [{ type: "object" }, { type: "object" }],
		});
	});

	it("rejects branch-valid arguments that violate common constraints", () => {
		const schema = actionParameterSchemaToJsonSchema(filter);
		for (const input of [
			{ mode: "literal", text: "" },
			JSON.stringify({ mode: "literal", text: "x" }),
			{ mode: "all", text: "x" },
		]) {
			const errors: string[] = [];
			validateSchema(schema, input, "filter", errors);
			expect(errors.length).toBeGreaterThan(0);
		}
	});

	it("preserves exact literal bytes and permits unfiltered lookup", () => {
		for (const input of [
			{ mode: "literal", text: '  "Mira’s story"\n' },
			{ mode: "all" },
		]) {
			const errors: string[] = [];
			expect(
				validateSchema(
					actionParameterSchemaToJsonSchema(filter),
					input,
					"filter",
					errors,
				),
			).toEqual(input);
			expect(errors).toEqual([]);
		}
	});

	it("enforces both union keywords and their common numeric bound", () => {
		const schema = actionParameterSchemaToJsonSchema({
			type: "number",
			minimum: 2,
			anyOf: [{ type: "number", maximum: 9 }],
			oneOf: [
				{ type: "number", maximum: 5 },
				{ type: "number", minimum: 8 },
			],
		});
		for (const [value, valid] of [
			[1, false],
			[3, true],
			[6, false],
			[8, true],
			[10, false],
		] as const) {
			const errors: string[] = [];
			validateSchema(schema, value, "amount", errors);
			expect(errors.length === 0).toBe(valid);
		}
	});

	it("preserves pure mixed-type unions without inventing an outer type", () => {
		const schema = actionParameterSchemaToJsonSchema({
			anyOf: [{ type: "string" }, { type: "number" }],
		});
		expect(schema.type).toBeUndefined();
		for (const input of ["text", 3]) {
			const errors: string[] = [];
			expect(validateSchema(schema, input, "value", errors)).toBe(input);
			expect(errors).toEqual([]);
		}
	});

	it("does not let a branch default satisfy an explicitly required common field", () => {
		const schema = actionParameterSchemaToJsonSchema({
			type: "object",
			properties: { scope: { type: "string" } },
			required: ["scope"],
			anyOf: [
				{
					type: "object",
					properties: { scope: { type: "string", default: "all" } },
				},
			],
		});
		const errors: string[] = [];
		validateSchema(schema, {}, "filter", errors);
		expect(errors).toContain("Missing required argument 'filter.scope'");
	});

	it("retains common normalization and defaults after a successful branch", () => {
		const schema = actionParameterSchemaToJsonSchema({
			type: "object",
			properties: {
				mode: { type: "string", enum: ["all"] },
				limit: { type: "integer", default: 2 },
			},
			anyOf: [{ type: "object", properties: { mode: { type: "string" } } }],
		});
		const errors: string[] = [];
		expect(validateSchema(schema, { mode: " all " }, "filter", errors)).toEqual(
			{ mode: "all", limit: 2 },
		);
		expect(errors).toEqual([]);
	});
});
