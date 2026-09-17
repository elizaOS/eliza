/** Covers Cerebras schema normalization across every JSON-schema child form. */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	normalizeSchemaForCerebras,
	sanitizeFunctionNameForCerebras,
} from "../schema-compat";

describe("normalizeSchemaForCerebras", () => {
	it.each(["integer", "number"])(
		"preserves nullable %s arguments and numeric bounds without string coercion",
		(type) => {
			for (const nullFirst of [false, true]) {
				const numeric = { type, minimum: 1, maximum: 50, multipleOf: 0.5 };
				const branches = [{ type: "null" }, numeric];
				const schema = {
					type: "object",
					properties: {
						limit: {
							description: "Explicit page size or no page size.",
							anyOf: nullFirst ? branches : [...branches].reverse(),
						},
					},
					additionalProperties: false,
				};
				const before = JSON.stringify(schema);
				const normalized = normalizeSchemaForCerebras(
					schema,
					true,
				) as typeof schema;
				const originalValidator = z.fromJSONSchema(schema);
				const normalizedValidator = z.fromJSONSchema(normalized);
				for (const value of [
					null,
					1,
					1.5,
					50,
					51,
					0,
					-1,
					"50",
					"null",
					{},
					[],
				]) {
					const original = originalValidator.safeParse({ limit: value });
					const parsed = normalizedValidator.safeParse({ limit: value });
					expect(parsed.success).toBe(original.success);
					if (parsed.success) expect(parsed.data).toEqual({ limit: value });
				}
				expect(normalizedValidator.parse({})).toEqual({});

				expect(normalized.properties?.limit).toEqual({
					...numeric,
					type: [type, "null"],
					description: "Explicit page size or no page size.",
				});
				expect(JSON.stringify(schema)).toBe(before);
				expect(normalizeSchemaForCerebras(normalized, true)).toEqual(
					normalized,
				);
				expect(
					normalizeSchemaForCerebras(schema, true, { strict: false }),
				).toEqual(schema);
			}
		},
	);

	it("preserves nullable unions with sibling or branch constraints it cannot combine", () => {
		for (const limit of [
			{ anyOf: [{ type: "integer", enum: [1, 5] }, { type: "null" }] },
			{ anyOf: [{ type: "integer", const: 5 }, { type: "null" }] },
			{ anyOf: [{ type: "integer" }, { type: "null", enum: [] }] },
			{ anyOf: [{ type: "integer" }, { type: "null" }], not: { const: 5 } },
			{ anyOf: [{ type: "integer", minimum: "1" }, { type: "null" }] },
			{
				anyOf: [
					{ type: "integer", description: "Only whole records." },
					{ type: "null" },
				],
			},
		]) {
			const schema = {
				type: "object",
				properties: { limit },
				additionalProperties: false,
			};
			expect(normalizeSchemaForCerebras(schema, true)).toEqual(schema);
		}
	});

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

	it("rewrites nested oneOf to anyOf under strict mode", () => {
		// The live failure shape: a property offering string-or-array via oneOf
		// (plugin-calendar's recurrence field) aborted every planner call on
		// Cerebras with "'oneOf' is not permitted". Verified against the live
		// API: the identical payload with anyOf is accepted.
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: {
				recurrence: {
					oneOf: [
						{ type: "string" },
						{ type: "array", items: { type: "string" } },
					],
				},
			},
		}) as Record<string, unknown>;
		const recurrence = (result.properties as Record<string, unknown>)
			.recurrence as Record<string, unknown>;
		expect(recurrence.oneOf).toBeUndefined();
		expect(recurrence.anyOf).toHaveLength(2);
	});

	it("appends migrated oneOf branches after existing anyOf branches", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: {
				value: {
					anyOf: [{ type: "number" }],
					oneOf: [{ type: "string" }],
				},
			},
		}) as Record<string, unknown>;
		const value = (result.properties as Record<string, unknown>)
			.value as Record<string, unknown>;
		expect(value.oneOf).toBeUndefined();
		expect(value.anyOf).toMatchObject([{ type: "number" }, { type: "string" }]);
	});

	it("keeps oneOf intact for non-strict tools", () => {
		const result = normalizeSchemaForCerebras(
			{
				type: "object",
				properties: {
					recurrence: { oneOf: [{ type: "string" }] },
				},
			},
			false,
			{ strict: false },
		) as Record<string, unknown>;
		const recurrence = (result.properties as Record<string, unknown>)
			.recurrence as Record<string, unknown>;
		expect(recurrence.oneOf).toHaveLength(1);
		expect(recurrence.anyOf).toBeUndefined();
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
		// Strict mode folds `oneOf` into `anyOf` (Cerebras's strict grammar
		// rejects `oneOf`), so the original anyOf branch and the migrated
		// oneOf branch both land in anyOf and the oneOf key disappears.
		expect(result.oneOf).toBeUndefined();
		const anyOf = result.anyOf as unknown[];
		expect(anyOf).toHaveLength(2);
		for (const branch of anyOf) expectClosed(branch);
		for (const key of ["allOf", "prefixItems"] as const) {
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
