import { describe, expect, it } from "vitest";
import {
	countSchemaOptionalParameters,
	DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT,
	schemaExceedsOptionalParameterLimit,
} from "./schema-optional-params.ts";

describe("countSchemaOptionalParameters", () => {
	it("returns 0 for non-object inputs", () => {
		expect(countSchemaOptionalParameters(undefined)).toBe(0);
		expect(countSchemaOptionalParameters(null)).toBe(0);
		expect(countSchemaOptionalParameters("nope")).toBe(0);
		expect(countSchemaOptionalParameters({ type: "string" })).toBe(0);
	});

	it("counts only properties absent from required", () => {
		expect(
			countSchemaOptionalParameters({
				type: "object",
				properties: { a: { type: "string" }, b: { type: "string" } },
				required: ["a"],
			}),
		).toBe(1);
	});

	it("recurses into nested object properties", () => {
		expect(
			countSchemaOptionalParameters({
				type: "object",
				properties: {
					outer: {
						type: "object",
						properties: { x: { type: "string" }, y: { type: "string" } },
						required: ["x"],
					},
				},
				required: ["outer"],
			}),
		).toBe(1); // outer required (0) + nested y optional (1)
	});

	it("recurses into array items (single and tuple)", () => {
		expect(
			countSchemaOptionalParameters({
				type: "object",
				properties: {
					list: {
						type: "array",
						items: {
							type: "object",
							properties: { v: { type: "string" } },
							required: [],
						},
					},
				},
				required: ["list"],
			}),
		).toBe(1); // list required (0) + item.v optional (1)

		expect(
			countSchemaOptionalParameters({
				type: "array",
				items: [
					{
						type: "object",
						properties: { p: { type: "string" } },
						required: [],
					},
					{
						type: "object",
						properties: { q: { type: "string" } },
						required: [],
					},
				],
			}),
		).toBe(2);
	});

	it("schemaExceedsOptionalParameterLimit respects the default and custom limits", () => {
		const wide = {
			type: "object",
			properties: Object.fromEntries(
				Array.from(
					{ length: DEFAULT_STRUCTURED_OUTPUT_OPTIONAL_PARAM_LIMIT + 1 },
					(_, i) => [`f${i}`, { type: "string" }],
				),
			),
			required: [],
		};
		expect(schemaExceedsOptionalParameterLimit(wide)).toBe(true);
		expect(schemaExceedsOptionalParameterLimit(wide, 10_000)).toBe(false);
	});
});
