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
