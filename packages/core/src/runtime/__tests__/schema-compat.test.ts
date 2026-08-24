/** Covers Cerebras schema normalization across every JSON-schema child form. */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import * as cerebrasSchemaCompat from "../schema-compat";
import {
	normalizeSchemaForCerebras,
	sanitizeFunctionNameForCerebras,
} from "../schema-compat";

const {
	CEREBRAS_SCHEMA_UNBOUNDED,
	MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
	MAX_CEREBRAS_SCHEMA_WALK_NODES,
	cloneSchemaForBoundedTransport,
	isCerebrasSchemaUnbounded,
} = cerebrasSchemaCompat;

/**
 * Builds an object chain whose deepest node sits exactly `depth` levels below
 * the root, so callers can probe the walk-depth boundary precisely.
 */
function nestedObjectChain(depth: number): Record<string, unknown> {
	let node: Record<string, unknown> = { type: "string" };
	for (let level = 0; level < depth; level += 1) {
		node = { type: "object", properties: { inner: node } };
	}
	return node;
}

function captureThrow(attempt: () => unknown): unknown {
	try {
		attempt();
	} catch (error) {
		return error;
	}
	return undefined;
}

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

describe("sanitizeFunctionNameForCerebras edge inputs", () => {
	it("returns the empty string unchanged", () => {
		expect(sanitizeFunctionNameForCerebras("")).toBe("");
	});

	it("replaces each disallowed character with exactly one underscore", () => {
		expect(sanitizeFunctionNameForCerebras("a!@#b")).toBe("a___b");
		expect(sanitizeFunctionNameForCerebras("café table")).toBe("caf__table");
	});

	it("is idempotent on already-sanitized output", () => {
		const once = sanitizeFunctionNameForCerebras("ns:fetch.all v2/β");
		expect(sanitizeFunctionNameForCerebras(once)).toBe(once);
	});
});

describe("isCerebrasSchemaUnbounded", () => {
	it("recognizes the walk-budget rejection raised by the normalizer", () => {
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic.not = cyclic;
		const caught = captureThrow(() => normalizeSchemaForCerebras(cyclic));
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe(CEREBRAS_SCHEMA_UNBOUNDED);
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
	});

	it("rejects plain errors, other ElizaErrors, and non-error values", () => {
		expect(isCerebrasSchemaUnbounded(new Error("plain"))).toBe(false);
		expect(
			isCerebrasSchemaUnbounded(new ElizaError("other", { code: "OTHER" })),
		).toBe(false);
		expect(isCerebrasSchemaUnbounded(CEREBRAS_SCHEMA_UNBOUNDED)).toBe(false);
		expect(isCerebrasSchemaUnbounded(null)).toBe(false);
		expect(isCerebrasSchemaUnbounded(undefined)).toBe(false);
	});
});

describe("normalizeSchemaForCerebras walk budgets", () => {
	it("accepts a chain whose deepest node sits exactly at the depth limit", () => {
		const schema = nestedObjectChain(MAX_CEREBRAS_SCHEMA_WALK_DEPTH);
		const result = normalizeSchemaForCerebras(schema) as Record<
			string,
			unknown
		>;
		expect(result.additionalProperties).toBe(false);
		let deepest = (result.properties as Record<string, unknown>)
			.inner as Record<string, unknown>;
		while (
			deepest.properties &&
			(deepest.properties as Record<string, unknown>).inner
		) {
			expect(deepest.additionalProperties).toBe(false);
			deepest = (deepest.properties as Record<string, unknown>).inner as Record<
				string,
				unknown
			>;
		}
		expect(deepest).toEqual({ type: "string" });
	});

	it("fails closed one level past the depth limit", () => {
		const caught = captureThrow(() =>
			normalizeSchemaForCerebras(nestedObjectChain(65)),
		);
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
		const context = (caught as ElizaError).context;
		expect(context?.depth).toBe(65);
		expect(context?.max).toBe(MAX_CEREBRAS_SCHEMA_WALK_DEPTH);
	});

	it("trips the aggregate node budget before touching a huge sparse array", () => {
		const caught = captureThrow(() =>
			normalizeSchemaForCerebras({
				type: "array",
				items: new Array(MAX_CEREBRAS_SCHEMA_WALK_NODES + 1),
			}),
		);
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
		expect((caught as ElizaError).context?.maxNodes).toBe(
			MAX_CEREBRAS_SCHEMA_WALK_NODES,
		);
	});

	it("reports a self-referential schema as a cycle", () => {
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic.not = cyclic;
		const caught = captureThrow(() => normalizeSchemaForCerebras(cyclic));
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
		expect((caught as ElizaError).context?.cycle).toBe(true);
	});

	it("lets siblings share one sub-schema without tripping cycle detection", () => {
		const shared = { type: "string" };
		const result = normalizeSchemaForCerebras({
			type: "object",
			properties: { a: shared, b: shared },
		}) as Record<string, unknown>;
		const props = result.properties as Record<string, unknown>;
		expect(props.a).toEqual({ type: "string" });
		expect(props.b).toEqual({ type: "string" });
		expect(props.a).not.toBe(props.b);
	});

	it("converts an accessor descriptor into the unbounded failure", () => {
		const hostile: Record<string, unknown> = { type: "object" };
		Object.defineProperty(hostile, "properties", {
			enumerable: true,
			get() {
				return {};
			},
		});
		const caught = captureThrow(() => normalizeSchemaForCerebras(hostile));
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
		const context = (caught as ElizaError).context;
		expect(context?.accessor).toBe(true);
		expect(context?.key).toBe("properties");
	});

	it("contains a hostile array proxy without leaking its raw TypeError", () => {
		const proxyArray = new Proxy([], {
			getPrototypeOf() {
				throw new TypeError("prototype inspection denied");
			},
		});
		const caught = captureThrow(() =>
			normalizeSchemaForCerebras({ type: "array", items: proxyArray }),
		);
		expect(caught).toBeInstanceOf(ElizaError);
		expect(caught).not.toBeInstanceOf(TypeError);
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
	});

	it("preserves holes while normalizing sparse arrays", () => {
		const sparse: unknown[] = new Array(2);
		sparse[1] = { type: "object" };
		const result = normalizeSchemaForCerebras({
			type: "array",
			items: sparse,
		}) as Record<string, unknown>;
		const items = result.items as unknown[];
		expect(items).toHaveLength(2);
		expect(0 in items).toBe(false);
		expect(items[1]).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		});
	});
});

describe("normalizeSchemaForCerebras illegal root wrapping", () => {
	it("wraps a scalar root under properties.value with required", () => {
		expect(normalizeSchemaForCerebras({ type: "string" }, true)).toEqual({
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
			additionalProperties: false,
		});
	});

	it("wraps an enum root and carries the enum values verbatim", () => {
		expect(
			normalizeSchemaForCerebras({ enum: ["read", "write"] }, true),
		).toEqual({
			type: "object",
			properties: { value: { enum: ["read", "write"] } },
			required: ["value"],
			additionalProperties: false,
		});
	});

	it("wraps a not-root and keeps walking the wrapped sub-schema", () => {
		expect(
			normalizeSchemaForCerebras({ not: { type: "string" } }, true),
		).toEqual({
			type: "object",
			properties: { value: { not: { type: "string" } } },
			required: ["value"],
			additionalProperties: false,
		});
	});

	it("wraps a oneOf root and folds it into anyOf inside the wrapper", () => {
		const result = normalizeSchemaForCerebras(
			{ oneOf: [{ type: "string" }, { type: "number" }] },
			true,
		) as Record<string, unknown>;
		const value = (result.properties as Record<string, unknown>)
			.value as Record<string, unknown>;
		expect(value.oneOf).toBeUndefined();
		expect(value.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
		expect(result.required).toEqual(["value"]);
	});

	it("gives a non-strict tool a bare open object for a missing root", () => {
		expect(
			normalizeSchemaForCerebras(undefined, true, { strict: false }),
		).toEqual({ type: "object" });
	});
});

describe("normalizeSchemaForCerebras strict shaping edges", () => {
	it("keeps a dangling required list while injecting empty properties", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			required: ["ghost"],
		}) as Record<string, unknown>;
		expect(result.properties).toEqual({});
		expect(result.required).toEqual(["ghost"]);
		expect(result.additionalProperties).toBe(false);
	});

	it("treats an empty anyOf array as no alternatives", () => {
		const result = normalizeSchemaForCerebras({
			type: "object",
			anyOf: [],
		}) as Record<string, unknown>;
		expect(result.properties).toEqual({});
		expect(result.anyOf).toEqual([]);
		expect(result.additionalProperties).toBe(false);
	});
});

describe("cloneSchemaForBoundedTransport", () => {
	it("clones declared shape verbatim without applying Cerebras semantics", () => {
		const input = {
			type: "object",
			additionalProperties: { type: "string" },
		};
		const out = cloneSchemaForBoundedTransport(input) as Record<
			string,
			unknown
		>;
		expect(out).toEqual(input);
		expect(out).not.toBe(input);
		expect(out.additionalProperties).toEqual({ type: "string" });
		expect(out.properties).toBeUndefined();
	});

	it("passes primitives and bare arrays through by reference", () => {
		expect(cloneSchemaForBoundedTransport(null)).toBe(null);
		expect(cloneSchemaForBoundedTransport("text")).toBe("text");
		expect(cloneSchemaForBoundedTransport(42)).toBe(42);
		const arrayRoot = [{ type: "string" }];
		expect(cloneSchemaForBoundedTransport(arrayRoot)).toBe(arrayRoot);
	});

	it("preserves holes so tuple positions stay distinguishable", () => {
		const sparse: unknown[] = new Array(2);
		sparse[1] = { type: "object" };
		const out = cloneSchemaForBoundedTransport({
			type: "array",
			items: sparse,
		}) as Record<string, unknown>;
		const items = out.items as unknown[];
		expect(Array.isArray(items)).toBe(true);
		expect(items).toHaveLength(2);
		expect(0 in items).toBe(false);
		expect(items[1]).toEqual({ type: "object" });
		expect(items).not.toBe(sparse);
	});

	it("carries annotation data by reference without descending into it", () => {
		const defaultValue = { nested: ["a", "b"] };
		const examples = [[1, 2]];
		const constValue = { k: 1 };
		const extensionValue = { deep: true };
		const requiredList = ["x"];
		const input = {
			type: "string",
			default: defaultValue,
			examples,
			const: constValue,
			required: requiredList,
			"x-extension": extensionValue,
		};
		const out = cloneSchemaForBoundedTransport(input) as Record<
			string,
			unknown
		>;
		expect(out.default).toBe(defaultValue);
		expect(out.examples).toBe(examples);
		expect(out.const).toBe(constValue);
		expect(out.required).toBe(requiredList);
		expect(out["x-extension"]).toBe(extensionValue);
	});

	it("leaves a deeply frozen input untouched and still produces a fresh clone", () => {
		const input = Object.freeze({
			type: "object",
			properties: Object.freeze({ q: Object.freeze({ type: "string" }) }),
		});
		const out = cloneSchemaForBoundedTransport(input) as Record<
			string,
			unknown
		>;
		expect(out).toEqual(input);
		expect(out).not.toBe(input);
		expect((out.properties as Record<string, unknown>).q).not.toBe(
			(input.properties as Record<string, unknown>).q,
		);
	});

	it("fails closed on a cyclic graph", () => {
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic.not = cyclic;
		const caught = captureThrow(() => cloneSchemaForBoundedTransport(cyclic));
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
		expect((caught as ElizaError).context?.clone).toBe(true);
	});

	it("enforces the same depth budget as the normalizer", () => {
		const atLimit = cloneSchemaForBoundedTransport(
			nestedObjectChain(MAX_CEREBRAS_SCHEMA_WALK_DEPTH),
		);
		expect(atLimit).toEqual(nestedObjectChain(MAX_CEREBRAS_SCHEMA_WALK_DEPTH));
		const caught = captureThrow(() =>
			cloneSchemaForBoundedTransport(nestedObjectChain(65)),
		);
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
	});

	it("enforces the aggregate node budget", () => {
		const caught = captureThrow(() =>
			cloneSchemaForBoundedTransport({
				type: "array",
				items: new Array(MAX_CEREBRAS_SCHEMA_WALK_NODES + 1),
			}),
		);
		expect(isCerebrasSchemaUnbounded(caught)).toBe(true);
	});
});
