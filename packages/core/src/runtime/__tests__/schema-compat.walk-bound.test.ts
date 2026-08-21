/**
 * Fail-closed walk budget for `normalizeSchemaForCerebras`.
 * On origin develop the walker recursed with `Object.entries` and no
 * depth/cycle cap, so JSON.parse-legal 8k-deep `properties` nests and
 * cyclic `not` graphs RangeError'd. Overlay throws typed
 * `CEREBRAS_SCHEMA_UNBOUNDED` instead.
 *
 * Shaw CR on #23159 (live head 695b5444): wrap Array.isArray /
 * getPrototypeOf, path-local visiting so honest DAGs pass, and never
 * fall back to a `.length` get trap. Caller-path regressions go through
 * the same `normalizeSchemaForCerebras(schema, true, { strict })`
 * contract as `plugins/plugin-openai/models/text.ts` cerebrasMode.
 * Owning issue is linked from PR #23159 Relates to.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import {
	CEREBRAS_SCHEMA_UNBOUNDED,
	cloneSchemaForBoundedTransport,
	isCerebrasSchemaUnbounded,
	MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
	MAX_CEREBRAS_SCHEMA_WALK_NODES,
	normalizeSchemaForCerebras,
} from "../schema-compat";

function deepProperties(depth: number): Record<string, unknown> {
	let node: Record<string, unknown> = { type: "string" };
	for (let i = 0; i < depth; i++) {
		node = { type: "object", properties: { x: node } };
	}
	return node;
}

/**
 * Production Cerebras tool-schema hop in
 * `plugins/plugin-openai/models/text.ts` `normalizeNativeToolsForCall`:
 * `inputSchema = normalizeSchemaForCerebras(inputSchema, true, {
 *   strict: strict !== false,
 * })`. A throw here is the fail-closed gate before `toolSet` assignment
 * / provider dispatch.
 */
function normalizeCerebrasToolSchema(schema: unknown, strict = true): unknown {
	let providerDispatch = 0;
	try {
		const inputSchema = normalizeSchemaForCerebras(schema, true, { strict });
		providerDispatch += 1;
		return inputSchema;
	} catch (error) {
		expect(providerDispatch).toBe(0);
		throw error;
	}
}

function expectUnbounded(error: unknown): ElizaError {
	expect(error).toBeInstanceOf(ElizaError);
	expect(isCerebrasSchemaUnbounded(error)).toBe(true);
	expect((error as ElizaError).code).toBe(CEREBRAS_SCHEMA_UNBOUNDED);
	expect(error).not.toBeInstanceOf(TypeError);
	expect(error).not.toBeInstanceOf(RangeError);
	return error as ElizaError;
}

describe("normalizeSchemaForCerebras walk bound", () => {
	it("still closes an honest nested object schema", () => {
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

	it("fails closed on a cyclic not graph instead of RangeError", () => {
		const cyclic: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		cyclic.not = cyclic;
		const started = Date.now();
		try {
			normalizeSchemaForCerebras(cyclic, true);
			throw new Error("expected unbounded throw");
		} catch (error) {
			expect(Date.now() - started).toBeLessThan(250);
			expect(error).toBeInstanceOf(ElizaError);
			expect(isCerebrasSchemaUnbounded(error)).toBe(true);
			expect((error as ElizaError).code).toBe(CEREBRAS_SCHEMA_UNBOUNDED);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it("fails closed on a JSON.parse-legal over-deep properties nest", () => {
		const depth = 8000;
		let raw = '{"type":"string"}';
		for (let i = 0; i < depth; i++) {
			raw = `{"type":"object","properties":{"x":${raw}}}`;
		}
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		expect(parsed.type).toBe("object");
		const started = Date.now();
		try {
			normalizeSchemaForCerebras(parsed, true);
			throw new Error("expected unbounded throw");
		} catch (error) {
			expect(Date.now() - started).toBeLessThan(250);
			expect(isCerebrasSchemaUnbounded(error)).toBe(true);
			expect((error as ElizaError).context?.max).toBe(
				MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
			);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it("fails closed on an enumerable getter instead of invoking it", () => {
		const hostile: Record<string, unknown> = { type: "object" };
		Object.defineProperty(hostile, "properties", {
			enumerable: true,
			get() {
				throw new Error("getter invoked");
			},
		});
		expect(() => normalizeSchemaForCerebras(hostile, true)).toThrow(ElizaError);
		try {
			normalizeSchemaForCerebras(hostile, true);
		} catch (error) {
			expect(isCerebrasSchemaUnbounded(error)).toBe(true);
			expect((error as ElizaError).context?.accessor).toBe(true);
			expect((error as Error).message).not.toContain("getter invoked");
		}
	});

	it("fails closed just past the depth budget", () => {
		const over = deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH + 2);
		expect(() => normalizeSchemaForCerebras(over, true)).toThrow(ElizaError);
		try {
			normalizeSchemaForCerebras(over, true);
		} catch (error) {
			expect(isCerebrasSchemaUnbounded(error)).toBe(true);
		}
	});
});

describe("normalizeSchemaForCerebras caller-path Shaw CR", () => {
	it("wraps a revoked Array Proxy as typed unbounded instead of TypeError", () => {
		const { proxy, revoke } = Proxy.revocable([] as unknown[], {});
		revoke();
		try {
			normalizeCerebrasToolSchema(proxy);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			expect(typed.cause).toBeInstanceOf(TypeError);
			expect(typed.context?.inspection).toBe("isArray");
		}
	});

	it("wraps a revoked Array Proxy oneOf child and preserves TypeError cause", () => {
		const { proxy, revoke } = Proxy.revocable([{ type: "string" }], {});
		revoke();
		const schema = {
			type: "object",
			properties: {},
			oneOf: proxy,
		};
		try {
			normalizeCerebrasToolSchema(schema);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			expect(typed.cause).toBeInstanceOf(TypeError);
			expect(typeof typed.context?.inspection).toBe("string");
		}
	});

	it("wraps a hostile getPrototypeOf trap instead of leaking TypeError", () => {
		const items = [{ type: "string" }];
		const proxy = new Proxy(items, {
			getPrototypeOf() {
				throw new TypeError("prototype trap");
			},
		});
		const schema = {
			type: "object",
			properties: {
				xs: { type: "array", items: proxy },
			},
		};
		try {
			normalizeCerebrasToolSchema(schema);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			expect(typed.cause).toBeInstanceOf(TypeError);
			expect((typed.cause as Error).message).toContain("prototype trap");
			expect(typed.context?.inspection).toBe("isArrayRecord");
		}
	});

	it("does not fall back to a .length get trap when the own descriptor is hidden", () => {
		let lengthGets = 0;
		const items = [{ type: "string" }];
		const proxy = new Proxy(items, {
			get(target, prop, receiver) {
				if (prop === "length") {
					lengthGets += 1;
					return 1;
				}
				return Reflect.get(target, prop, receiver);
			},
			getOwnPropertyDescriptor(target, prop) {
				if (prop === "length") return undefined;
				return Reflect.getOwnPropertyDescriptor(target, prop);
			},
		});
		const schema = {
			type: "object",
			properties: {
				xs: { type: "array", items: proxy },
			},
		};
		try {
			normalizeCerebrasToolSchema(schema);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			// Real Array `length` is non-configurable, so a trap that hides
			// the descriptor throws a proxy invariant TypeError. That still
			// must wrap as CEREBRAS_SCHEMA_UNBOUNDED and must not read `.length`.
			expect(
				typed.context?.missingOwnLength === true ||
					typed.context?.inspection === "getOwnPropertyDescriptor",
			).toBe(true);
		}
		expect(lengthGets).toBe(0);
	});

	it("rejects a non-numeric own length descriptor without reading .length", () => {
		let lengthGets = 0;
		const items = [{ type: "string" }];
		const proxy = new Proxy(items, {
			get(target, prop, receiver) {
				if (prop === "length") {
					lengthGets += 1;
					return 1;
				}
				return Reflect.get(target, prop, receiver);
			},
			getOwnPropertyDescriptor(target, prop) {
				if (prop === "length") {
					return {
						value: "trapped",
						writable: true,
						enumerable: false,
						configurable: false,
					};
				}
				return Reflect.getOwnPropertyDescriptor(target, prop);
			},
		});
		const schema = {
			type: "object",
			properties: {
				xs: { type: "array", items: proxy },
			},
		};
		try {
			normalizeCerebrasToolSchema(schema);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			expect(typed.context?.arrayLength).toBe("trapped");
		}
		expect(lengthGets).toBe(0);
	});

	it("accepts an honest DAG that reuses the same schema object under two properties", () => {
		const shared = { type: "string" };
		const dag = {
			type: "object",
			properties: {
				a: shared,
				b: shared,
			},
		};
		const result = normalizeCerebrasToolSchema(dag) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		expect(props.a.type).toBe("string");
		expect(props.b.type).toBe("string");
	});

	it("still rejects a true cycle after path-local visiting unwind", () => {
		const cyclic: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		cyclic.not = cyclic;
		try {
			normalizeCerebrasToolSchema(cyclic);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			expect(typed.context?.cycle).toBe(true);
		}
	});

	it("does not execute get/has/prototype traps on an honest object Proxy", () => {
		const target = {
			type: "object",
			properties: { x: { type: "string" } },
		};
		let getHits = 0;
		let hasHits = 0;
		let protoHits = 0;
		const proxy = new Proxy(target, {
			get(t, p, r) {
				getHits += 1;
				return Reflect.get(t, p, r);
			},
			has(t, p) {
				hasHits += 1;
				return Reflect.has(t, p);
			},
			getPrototypeOf(t) {
				protoHits += 1;
				return Reflect.getPrototypeOf(t);
			},
		});
		const result = normalizeCerebrasToolSchema(proxy) as Record<
			string,
			unknown
		>;
		expect(result.type).toBe("object");
		expect(getHits).toBe(0);
		expect(hasHits).toBe(0);
		expect(protoHits).toBe(0);
	});

	it("walks sparse arrays from own length/index descriptors only", () => {
		const items: unknown[] = [];
		items[0] = { type: "string" };
		items[2] = { type: "number" };
		const schema = {
			type: "object",
			properties: {
				t: { type: "array", prefixItems: items },
			},
		};
		const result = normalizeCerebrasToolSchema(schema) as Record<
			string,
			unknown
		>;
		const t = (result.properties as Record<string, Record<string, unknown>>).t;
		expect(t.prefixItems).toHaveLength(3);
		expect((t.prefixItems as unknown[])[0]).toMatchObject({ type: "string" });
		expect((t.prefixItems as unknown[])[1]).toBeUndefined();
		expect(1 in (t.prefixItems as unknown[])).toBe(false);
		expect((t.prefixItems as unknown[])[2]).toMatchObject({ type: "number" });
	});

	it("accepts a schema at the exact depth budget and rejects one step past", () => {
		const atBudget = deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH);
		const result = normalizeCerebrasToolSchema(atBudget) as Record<
			string,
			unknown
		>;
		expect(result.type).toBe("object");

		try {
			normalizeCerebrasToolSchema(
				deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH + 1),
			);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			expect(typed.context?.max).toBe(MAX_CEREBRAS_SCHEMA_WALK_DEPTH);
		}
	});

	it("fails closed on an over-wide own-key node before cloning", () => {
		const wide: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		for (let i = 0; i < MAX_CEREBRAS_SCHEMA_WALK_NODES + 1; i++) {
			wide[`k${i}`] = true;
		}
		const started = Date.now();
		try {
			normalizeSchemaForCerebras(wide, true);
			throw new Error("expected unbounded throw");
		} catch (error) {
			expect(Date.now() - started).toBeLessThan(2000);
			const typed = expectUnbounded(error);
			expect(typed.context?.maxNodes).toBe(MAX_CEREBRAS_SCHEMA_WALK_NODES);
			expect(
				(typed.context?.visits as number) > MAX_CEREBRAS_SCHEMA_WALK_NODES,
			).toBe(true);
		}
	});
});

/**
 * `cloneSchemaForBoundedTransport` is the safe pre-pass the production
 * Cerebras path runs BEFORE `sanitizeJsonSchema`. It must carry the same
 * budgets and descriptor-only reflection as the normalizer while applying
 * zero Cerebras semantics — closing declared open maps here destroys the
 * `__eliza_record_entries` reverse transform sanitization builds (#11249).
 */
describe("cloneSchemaForBoundedTransport", () => {
	it("preserves declared open-map semantics verbatim", () => {
		const declared = {
			type: "object",
			properties: {
				customFields: {
					type: "object",
					additionalProperties: { type: "string" },
				},
				anything: { type: "object", additionalProperties: true },
			},
		};
		const cloned = cloneSchemaForBoundedTransport(declared) as Record<
			string,
			Record<string, Record<string, unknown>>
		>;
		expect(cloned).toEqual(declared);
		expect(cloned).not.toBe(declared);
		expect(cloned.properties.customFields.additionalProperties).toEqual({
			type: "string",
		});
		expect(cloned.properties.anything.additionalProperties).toBe(true);
		// No Cerebras closure, no injected empty `properties`, no oneOf rewrite.
		expect("properties" in cloned.properties.customFields).toBe(false);
	});

	it("keeps oneOf and a non-object root untouched", () => {
		const declared = { oneOf: [{ type: "string" }, { type: "number" }] };
		expect(cloneSchemaForBoundedTransport(declared)).toEqual(declared);
		expect(cloneSchemaForBoundedTransport("nope")).toBe("nope");
		expect(cloneSchemaForBoundedTransport(undefined)).toBeUndefined();
		expect(cloneSchemaForBoundedTransport(null)).toBeNull();
	});

	it("clones deeply so sanitization cannot mutate the caller's schema", () => {
		const inner = { type: "string" };
		const declared = { type: "object", properties: { a: inner, b: inner } };
		const cloned = cloneSchemaForBoundedTransport(declared) as {
			properties: Record<string, unknown>;
		};
		expect(cloned.properties.a).toEqual({ type: "string" });
		expect(cloned.properties.a).not.toBe(inner);
		// Honest DAG: the same object under two keys is not a cycle.
		expect(cloned.properties.b).toEqual({ type: "string" });
	});

	it("preserves array holes instead of materializing undefined", () => {
		const prefixItems: unknown[] = [];
		prefixItems[0] = { type: "string" };
		prefixItems[2] = { type: "number" };
		const cloned = cloneSchemaForBoundedTransport({
			type: "array",
			prefixItems,
		}) as { prefixItems: unknown[] };
		expect(cloned.prefixItems).toHaveLength(3);
		expect(1 in cloned.prefixItems).toBe(false);
		expect(cloned.prefixItems[2]).toEqual({ type: "number" });

		const explicit = cloneSchemaForBoundedTransport({
			anyOf: [undefined],
		}) as { anyOf: unknown[] };
		expect(0 in explicit.anyOf).toBe(true);
		expect(explicit.anyOf[0]).toBeUndefined();
	});

	it("fails closed on a cyclic graph", () => {
		const cyclic: Record<string, unknown> = { type: "object" };
		cyclic.not = cyclic;
		const started = Date.now();
		try {
			cloneSchemaForBoundedTransport(cyclic);
			throw new Error("expected unbounded throw");
		} catch (error) {
			expect(Date.now() - started).toBeLessThan(250);
			expect(expectUnbounded(error).context?.cycle).toBe(true);
		}
	});

	it("accepts and rejects exactly what normalizeSchemaForCerebras does", () => {
		// Shaw's exact-head repro on fb67e329: the pre-pass counted RAW object
		// nesting, so a legal `default` annotation nested past its budget was
		// rejected while the normalizer accepted it. The clone now walks the
		// same schema-bearing keywords with the same depth accounting, so the
		// two must agree on every case below.
		let annotation: Record<string, unknown> = { leaf: true };
		for (let i = 0; i < MAX_CEREBRAS_SCHEMA_WALK_DEPTH * 2 + 1; i += 1) {
			annotation = { nested: annotation };
		}
		let deepAnnotation: Record<string, unknown> = { leaf: true };
		for (let i = 0; i < 20_000; i += 1) {
			deepAnnotation = { nested: deepAnnotation };
		}
		const cyclicAnnotation: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		cyclicAnnotation.default = cyclicAnnotation;
		const cyclicKeyword: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		cyclicKeyword.not = cyclicKeyword;

		const cases: Array<[string, unknown]> = [
			[
				"shaw repro default",
				{ type: "object", properties: {}, default: annotation },
			],
			[
				"20k default",
				{ type: "object", properties: {}, default: deepAnnotation },
			],
			[
				"20k examples",
				{ type: "object", properties: {}, examples: [deepAnnotation] },
			],
			[
				"20k extension",
				{ type: "object", properties: {}, "x-vendor": deepAnnotation },
			],
			["20k const", { type: "object", properties: {}, const: deepAnnotation }],
			["cyclic annotation", cyclicAnnotation],
			["cyclic keyword", cyclicKeyword],
			["properties at budget", deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH)],
			[
				"properties past budget",
				deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH + 1),
			],
		];

		const outcome = (run: () => unknown): string => {
			try {
				run();
				return "accepted";
			} catch (error) {
				return `${expectUnbounded(error).context?.max ?? "cycle"}`;
			}
		};

		for (const [label, schema] of cases) {
			expect([
				label,
				outcome(() => cloneSchemaForBoundedTransport(schema)),
			]).toEqual([
				label,
				outcome(() =>
					normalizeSchemaForCerebras(schema, true, { strict: true }),
				),
			]);
		}
	});

	it("carries annotation data across verbatim without walking it", () => {
		const deep: Record<string, unknown> = { a: { b: { c: 1 } } };
		const cloned = cloneSchemaForBoundedTransport({
			type: "object",
			properties: {},
			default: deep,
			enum: [1, 2],
			"x-vendor": { deep },
		}) as Record<string, unknown>;
		expect(cloned.default).toEqual({ a: { b: { c: 1 } } });
		expect(cloned.enum).toEqual([1, 2]);
		expect(cloned["x-vendor"]).toEqual({ deep: { a: { b: { c: 1 } } } });
		// Annotation values are the immutable descriptor snapshot, carried across
		// rather than re-walked — exactly what cloneOwnData does in the normalizer.
		expect(cloned.default).toBe(deep);
	});

	it("fails closed past the schema depth budget", () => {
		expect(() =>
			cloneSchemaForBoundedTransport(
				deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH),
			),
		).not.toThrow();
		try {
			cloneSchemaForBoundedTransport(
				deepProperties(MAX_CEREBRAS_SCHEMA_WALK_DEPTH + 1),
			);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			expect(typed.context?.max).toBe(MAX_CEREBRAS_SCHEMA_WALK_DEPTH);
			expect(typed.context?.clone).toBe(true);
		}
	});

	it("reserves array width before allocating a huge sparse array", () => {
		const sparse: unknown[] = [];
		sparse.length = MAX_CEREBRAS_SCHEMA_WALK_NODES + 1;
		const started = Date.now();
		try {
			cloneSchemaForBoundedTransport({ anyOf: sparse });
			throw new Error("expected unbounded throw");
		} catch (error) {
			expect(Date.now() - started).toBeLessThan(2000);
			expect(expectUnbounded(error).context?.maxNodes).toBe(
				MAX_CEREBRAS_SCHEMA_WALK_NODES,
			);
		}
	});

	it("fails closed on an accessor and on a revoked Proxy", () => {
		const hostile: Record<string, unknown> = { type: "object" };
		Object.defineProperty(hostile, "properties", {
			enumerable: true,
			get() {
				throw new Error("getter invoked");
			},
		});
		try {
			cloneSchemaForBoundedTransport(hostile);
			throw new Error("expected unbounded throw");
		} catch (error) {
			const typed = expectUnbounded(error);
			expect(typed.context?.accessor).toBe(true);
			expect(typed.message).not.toContain("getter invoked");
		}

		const { proxy, revoke } = Proxy.revocable([] as unknown[], {});
		revoke();
		try {
			cloneSchemaForBoundedTransport(proxy);
			throw new Error("expected unbounded throw");
		} catch (error) {
			expect(expectUnbounded(error).cause).toBeInstanceOf(TypeError);
		}
	});

	it("never executes get/has/prototype traps", () => {
		let getHits = 0;
		let hasHits = 0;
		let protoHits = 0;
		const proxy = new Proxy(
			{ type: "object", properties: { x: { type: "string" } } },
			{
				get(t, prop, r) {
					getHits += 1;
					return Reflect.get(t, prop, r);
				},
				has(t, prop) {
					hasHits += 1;
					return Reflect.has(t, prop);
				},
				getPrototypeOf(t) {
					protoHits += 1;
					return Reflect.getPrototypeOf(t);
				},
			},
		);
		expect(cloneSchemaForBoundedTransport(proxy)).toEqual({
			type: "object",
			properties: { x: { type: "string" } },
		});
		expect(getHits).toBe(0);
		expect(hasHits).toBe(0);
		expect(protoHits).toBe(0);
	});
});
