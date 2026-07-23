/**
 * Unit coverage for the Cerebras schema/function-name compatibility shims
 * (`normalizeSchemaForCerebras`, `sanitizeFunctionNameForCerebras`): closing
 * empty object schemas (explicit empty `properties` + `additionalProperties:
 * false` — Cerebras rejects a bare `{type:"object"}` with `Object fields
 * require at least one of: 'properties' or 'anyOf'`), recursion into nested
 * properties and array items, and identifier rewriting. Pure functions,
 * deterministic.
 */
import { describe, expect, it } from "vitest";
import {
	normalizeSchemaForCerebras,
	sanitizeFunctionNameForCerebras,
} from "../schema-compat";

describe("normalizeSchemaForCerebras", () => {
	it("closes empty-properties object schemas (keeps properties:{} + additionalProperties:false)", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: {},
			additionalProperties: false,
			required: [],
		}) as Record<string, unknown>;
		expect(result.type).toBe("object");
		expect(result.properties).toEqual({});
		expect(result.additionalProperties).toBe(false);
		expect(result.required).toBeUndefined();
	});

	it("closes a bare object schema (adds properties:{} + additionalProperties:false)", () => {
		// A bare `{type:"object"}` is request-fatal on Cerebras: the grammar
		// compiler 400s the ENTIRE chat completion (`Object fields require at
		// least one of: 'properties' or 'anyOf'`). Regression guard for the
		// no-arg terminal tools (IGNORE / STOP) whose schema is exactly this
		// shape — the earlier strip-the-keys behavior produced it.
		const result = normalizeSchemaForCerebras({
			type: "object",
		}) as Record<string, unknown>;
		expect(result.type).toBe("object");
		expect(result.properties).toEqual({});
		expect(result.additionalProperties).toBe(false);
	});

	it("closes an open empty object (additionalProperties:true becomes false)", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			additionalProperties: true,
		}) as Record<string, unknown>;
		expect(result.properties).toEqual({});
		expect(result.additionalProperties).toBe(false);
	});

	it("returns a closed empty object schema for a non-object root", () => {
		const result = normalizeSchemaForCerebras(undefined, true) as Record<
			string,
			unknown
		>;
		expect(result).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		});
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
		expect(inner.properties).toEqual({});
		expect(inner.additionalProperties).toBe(false);
	});

	it("closes a bare nested object property", () => {
		// e.g. PAGE_DELEGATE's free-form `parameters` arg: nested
		// `{type:"object"}` without properties is rejected by Cerebras exactly
		// like the root shape.
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: { params: { type: "object", description: "freeform" } },
			required: ["params"],
		}) as Record<string, unknown>;
		const params = (
			result.properties as Record<string, Record<string, unknown>>
		).params;
		expect(params.properties).toEqual({});
		expect(params.additionalProperties).toBe(false);
		expect(params.description).toBe("freeform");
	});

	it("recurses into array items", () => {
		const result = normalizeSchemaForCerebras({
			type: "array",
			items: { type: "object", properties: {}, additionalProperties: false },
		}) as Record<string, unknown>;
		const items = result.items as Record<string, unknown>;
		expect(items.properties).toEqual({});
		expect(items.additionalProperties).toBe(false);
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
