import { describe, expect, it } from "vitest";
import {
	normalizeSchemaForCerebras,
	sanitizeFunctionNameForCerebras,
} from "../schema-compat";

describe("normalizeSchemaForCerebras", () => {
	it("strips empty-properties + additionalProperties:false on object schemas", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: {},
			additionalProperties: false,
			required: [],
		}) as Record<string, unknown>;
		expect(result.type).toBe("object");
		expect(result.properties).toBeUndefined();
		expect(result.additionalProperties).toBeUndefined();
		expect(result.required).toBeUndefined();
	});

	it("strips properties on bare object schema", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
		}) as Record<string, unknown>;
		expect(result.type).toBe("object");
		expect(result.properties).toBeUndefined();
	});

	it("preserves populated object schemas", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: { q: { type: "string" } },
			required: ["q"],
		}) as Record<string, unknown>;
		expect(result.properties).toEqual({ q: { type: "string" } });
		expect(result.required).toEqual(["q"]);
	});

	it("recurses into nested object properties", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: {
				inner: { type: "object", properties: {}, additionalProperties: false },
			},
			required: ["inner"],
		}) as Record<string, unknown>;
		const inner = (result.properties as Record<string, Record<string, unknown>>)
			.inner;
		expect(inner.properties).toBeUndefined();
		expect(inner.additionalProperties).toBeUndefined();
	});

	it("recurses into array items", () => {
		const result = normalizeSchemaForCerebras({
			type: "array",
			items: { type: "object", properties: {}, additionalProperties: false },
		}) as Record<string, unknown>;
		const items = result.items as Record<string, unknown>;
		expect(items.properties).toBeUndefined();
		expect(items.additionalProperties).toBeUndefined();
	});

	it("preserves objects that have anyOf/oneOf even with empty properties", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			anyOf: [{ type: "string" }, { type: "number" }],
		}) as Record<string, unknown>;
		expect(Array.isArray(result.anyOf)).toBe(true);
		expect((result.anyOf as unknown[]).length).toBe(2);
	});

	it("returns non-object scalars unchanged", () => {
		expect(normalizeSchemaForCerebras({ type: "string" })).toEqual({
			type: "string",
		});
		expect(normalizeSchemaForCerebras(null)).toBe(null);
		expect(normalizeSchemaForCerebras(undefined)).toBe(undefined);
	});
});

describe("sanitizeFunctionNameForCerebras", () => {
	it("rewrites dotted identifiers", () => {
		expect(sanitizeFunctionNameForCerebras("math.factorial")).toBe(
			"math_factorial",
		);
		expect(sanitizeFunctionNameForCerebras("algebra.quadratic.roots")).toBe(
			"algebra_quadratic_roots",
		);
	});

	it("preserves underscores, dashes, alphanumerics", () => {
		expect(sanitizeFunctionNameForCerebras("WEB_SEARCH")).toBe("WEB_SEARCH");
		expect(sanitizeFunctionNameForCerebras("kebab-case")).toBe("kebab-case");
		expect(sanitizeFunctionNameForCerebras("plain123")).toBe("plain123");
	});

	it("rewrites colon, slash, and whitespace", () => {
		expect(sanitizeFunctionNameForCerebras("ns:fn")).toBe("ns_fn");
		expect(sanitizeFunctionNameForCerebras("a/b/c")).toBe("a_b_c");
		expect(sanitizeFunctionNameForCerebras("a b c")).toBe("a_b_c");
	});
});
