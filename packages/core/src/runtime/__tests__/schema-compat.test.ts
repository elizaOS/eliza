/** Covers Cerebras schema normalization across every JSON-schema child form. */
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
		expect(result.additionalProperties).toBe(false);
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

	it("preserves anyOf object alternatives without adding an empty properties map", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			anyOf: [{ type: "string" }, { type: "number" }],
		}) as Record<string, unknown>;
		expect(Array.isArray(result.anyOf)).toBe(true);
		expect((result.anyOf as unknown[]).length).toBe(2);
		expect(result.properties).toBeUndefined();
		expect(result.additionalProperties).toBe(false);
	});

	it("walks every schema-bearing keyword", () => {
		const bareObject = () => ({ type: "object" });
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: {
				direct: bareObject(),
			},
			patternProperties: { "^x-": bareObject() },
			$defs: { hoisted: bareObject() },
			definitions: { legacy: bareObject() },
			dependentSchemas: { direct: bareObject() },
			dependencies: {
				direct: bareObject(),
				names: ["direct"],
			},
			anyOf: [bareObject()],
			oneOf: [bareObject()],
			allOf: [bareObject()],
			prefixItems: [bareObject()],
			items: [bareObject(), bareObject()],
			contains: bareObject(),
			propertyNames: bareObject(),
			not: bareObject(),
			if: bareObject(),
			// biome-ignore lint/suspicious/noThenProperty: JSON Schema reserves this key for conditional branches.
			then: bareObject(),
			else: bareObject(),
			additionalProperties: false,
			unevaluatedProperties: bareObject(),
			unevaluatedItems: bareObject(),
			contentSchema: bareObject(),
			additionalItems: bareObject(),
		}) as Record<string, unknown>;

		const expectClosed = (value: unknown) => {
			expect(value).toMatchObject({
				type: "object",
				properties: {},
				additionalProperties: false,
			});
		};
		expectClosed((result.properties as Record<string, unknown>).direct);
		expectClosed((result.patternProperties as Record<string, unknown>)["^x-"]);
		expectClosed((result.$defs as Record<string, unknown>).hoisted);
		expectClosed((result.definitions as Record<string, unknown>).legacy);
		expectClosed((result.dependentSchemas as Record<string, unknown>).direct);
		expectClosed((result.dependencies as Record<string, unknown>).direct);
		expect((result.dependencies as Record<string, unknown>).names).toEqual([
			"direct",
		]);
		for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"] as const) {
			expectClosed((result[key] as unknown[])[0]);
		}
		for (const item of result.items as unknown[]) expectClosed(item);
		for (const key of [
			"contains",
			"propertyNames",
			"not",
			"if",
			"then",
			"else",
			"unevaluatedProperties",
			"unevaluatedItems",
			"contentSchema",
			"additionalItems",
		] as const) {
			expectClosed(result[key]);
		}
	});

	it("closes inferred and nullable object nodes", () => {
		expect(normalizeSchemaForCerebras({ properties: {} })).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		});
		expect(
			normalizeSchemaForCerebras({ type: ["object", "null"] }),
		).toMatchObject({
			type: ["object", "null"],
			properties: {},
			additionalProperties: false,
		});
	});

	it("closes populated objects reached through tuple schemas", () => {
		const result = normalizeSchemaForCerebras({
			type: "array",
			prefixItems: [
				{
					type: "object",
					properties: { detail: { type: "string" } },
					required: ["detail"],
				},
			],
			items: false,
		}) as Record<string, unknown>;
		expect((result.prefixItems as unknown[])[0]).toEqual({
			type: "object",
			properties: { detail: { type: "string" } },
			required: ["detail"],
			additionalProperties: false,
		});
	});

	it("preserves open-map semantics for non-strict tools", () => {
		const schema = {
			type: "object",
			additionalProperties: { type: "string" },
		};
		expect(normalizeSchemaForCerebras(schema, true, { strict: false })).toEqual(
			schema,
		);
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
