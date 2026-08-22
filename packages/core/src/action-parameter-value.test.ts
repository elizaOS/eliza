/**
 * Deterministic tests for the planner action-parameter walk. No live model:
 * the walker is the production parseActionParams / toActionParameterValue
 * used on untrusted `{ params }` JSON.
 */
import { describe, expect, it } from "vitest";
import {
	ACTION_PARAMETER_UNBOUNDED,
	MAX_ACTION_PARAMETER_DEPTH,
	MAX_ACTION_PARAMETER_NODES,
	toActionParameterValue,
} from "./action-parameter-value";
import { parseActionParams, validateActionParams } from "./actions";
import { ElizaError } from "./errors";
import type { Action, ActionParameters } from "./types";

function nestArray(depth: number): unknown {
	let value: unknown = "x";
	for (let index = 0; index < depth; index += 1) {
		value = [value];
	}
	return value;
}

describe("toActionParameterValue", () => {
	it("preserves honest scalars, lists, and nested records", () => {
		expect(toActionParameterValue("ok")).toBe("ok");
		expect(toActionParameterValue(3)).toBe(3);
		expect(toActionParameterValue(true)).toBe(true);
		expect(toActionParameterValue(null)).toBe(null);
		expect(toActionParameterValue(["1", { b: true }])).toEqual([
			"1",
			{ b: true },
		]);
		expect(toActionParameterValue({ a: ["1", { b: true }] })).toEqual({
			a: ["1", { b: true }],
		});
	});

	it("sanitizes model strings recursively without shortening them", () => {
		const long = `${"x".repeat(1_100_000)}🦊`;
		expect(toActionParameterValue(["\ud800abc", long])).toEqual(["�abc", long]);
	});

	it(`accepts a ${MAX_ACTION_PARAMETER_DEPTH}-deep array nest`, () => {
		expect(
			toActionParameterValue(nestArray(MAX_ACTION_PARAMETER_DEPTH)),
		).toEqual(nestArray(MAX_ACTION_PARAMETER_DEPTH));
	});

	it(`throws ${ACTION_PARAMETER_UNBOUNDED} one past depth ${MAX_ACTION_PARAMETER_DEPTH}`, () => {
		try {
			toActionParameterValue(nestArray(MAX_ACTION_PARAMETER_DEPTH + 1));
			expect.unreachable("parse should fail closed on over-budget depth");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
		}
	});

	it(`throws ${ACTION_PARAMETER_UNBOUNDED} past ${MAX_ACTION_PARAMETER_NODES} sparse holes`, () => {
		const sparse: unknown[] = [];
		sparse[MAX_ACTION_PARAMETER_NODES] = "x";
		try {
			toActionParameterValue(sparse);
			expect.unreachable(
				"parse should fail closed on over-budget sparse length",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
		}
	});

	it("preserves within-budget sparse holes and length", () => {
		const value: unknown[] = [];
		value[2] = "x";
		const result = toActionParameterValue(value) as unknown[];
		expect(result).toHaveLength(3);
		expect(0 in result).toBe(false);
		expect(1 in result).toBe(false);
		expect(Object.hasOwn(result, "2")).toBe(true);
		expect(result[2]).toBe("x");
	});

	it("converts explicit undefined slots to null without collapsing length", () => {
		const value: unknown[] = [undefined, undefined, "x"];
		const result = toActionParameterValue(value) as unknown[];
		expect(result).toHaveLength(3);
		expect(0 in result).toBe(true);
		expect(1 in result).toBe(true);
		expect(result[0]).toBe(null);
		expect(result[1]).toBe(null);
		expect(result[2]).toBe("x");
	});

	it("translates hostile primitive conversion and preserves its cause", () => {
		const conversionFailure = new Error("hostile primitive conversion");
		const hostile = new Proxy(() => undefined, {
			get() {
				throw conversionFailure;
			},
		});
		try {
			toActionParameterValue(hostile);
			expect.unreachable("primitive conversion should fail closed");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
			expect((error as Error).cause).toBe(conversionFailure);
		}
	});

	it("throws on a cyclic record without hanging", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		const started = performance.now();
		try {
			toActionParameterValue(cyclic);
			expect.unreachable("parse should fail closed on a cycle");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
		}
		expect(performance.now() - started).toBeLessThan(50);
	});

	it("does not invoke accessors while parsing", () => {
		let invoked = 0;
		const hostile = {
			get trap() {
				invoked += 1;
				return "x";
			},
		};
		try {
			toActionParameterValue(hostile);
			expect.unreachable("parse should fail closed on enumerable accessors");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
		}
		expect(invoked).toBe(0);
	});

	it("does not invoke array Proxy get/has traps while parsing", () => {
		let gets = 0;
		let hasCalls = 0;
		const proxy = new Proxy(["x"], {
			get() {
				gets += 1;
				throw new Error("get trap escaped");
			},
			has() {
				hasCalls += 1;
				throw new Error("has trap escaped");
			},
		});
		expect(toActionParameterValue(proxy)).toEqual(["x"]);
		expect(gets).toBe(0);
		expect(hasCalls).toBe(0);
	});

	it(`throws ${ACTION_PARAMETER_UNBOUNDED} on a revoked Proxy instead of TypeError`, () => {
		const { proxy, revoke } = Proxy.revocable(["x"], {});
		revoke();
		try {
			toActionParameterValue(proxy);
			expect.unreachable("parse should fail closed on a revoked Proxy");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
			expect((error as Error).name).not.toBe("TypeError");
			expect((error as Error).cause).toBeInstanceOf(TypeError);
			expect(String((error as Error).cause)).toMatch(/isArray/i);
		}
	});

	it("rescans honest shared child values after the parent frame returns", () => {
		const shared = { b: true };
		expect(toActionParameterValue({ a: shared, c: shared })).toEqual({
			a: { b: true },
			c: { b: true },
		});
	});

	it("fails closed on an 8k nest in under 50ms instead of RangeError", () => {
		const started = performance.now();
		try {
			toActionParameterValue(nestArray(8_000));
			expect.unreachable("parse should fail closed on an 8k nest");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
			expect((error as Error).name).not.toBe("RangeError");
		}
		expect(performance.now() - started).toBeLessThan(50);
	});

	it("translates a getOwnPropertyDescriptor trap to ACTION_PARAMETER_UNBOUNDED", () => {
		const hostile = new Proxy(
			{ payload: "x" },
			{
				getOwnPropertyDescriptor() {
					throw new Error("descriptor trap escaped");
				},
			},
		);
		try {
			toActionParameterValue(hostile);
			expect.unreachable("parse should fail closed on a descriptor trap");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
			expect((error as Error).message).not.toContain("trap escaped");
		}
	});
});

describe("parseActionParams", () => {
	it("parses honest wrapped and unwrapped action param records", () => {
		expect(
			parseActionParams({
				params: { SHELL_COMMAND: { command: "ls" } },
			}).get("SHELL_COMMAND"),
		).toEqual({ command: "ls" });
		expect(
			parseActionParams({ SHELL_COMMAND: { command: "ls" } }).get(
				"SHELL_COMMAND",
			),
		).toEqual({ command: "ls" });
		expect(parseActionParams("{ not json").size).toBe(0);
	});

	it("does not invoke action-slot accessors", () => {
		let invoked = 0;
		const hostile = {
			params: {
				get ACT() {
					invoked += 1;
					return { payload: "x" };
				},
			},
		};
		try {
			parseActionParams(hostile);
			expect.unreachable("parse should fail closed on action-slot accessors");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
		}
		expect(invoked).toBe(0);
	});

	it("does not invoke parameter-slot accessors", () => {
		let invoked = 0;
		const hostile = {
			params: {
				ACT: {
					get payload() {
						invoked += 1;
						return ["x"];
					},
				},
			},
		};
		try {
			parseActionParams(hostile);
			expect.unreachable(
				"parse should fail closed on parameter-slot accessors",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
		}
		expect(invoked).toBe(0);
	});

	it("does not invoke Proxy get/has traps on the production boundary", () => {
		let gets = 0;
		let hasCalls = 0;
		const proxy = new Proxy(
			{ params: { ACT: { payload: "x" } } },
			{
				get() {
					gets += 1;
					throw new Error("get trap escaped");
				},
				has() {
					hasCalls += 1;
					throw new Error("has trap escaped");
				},
			},
		);
		expect(parseActionParams(proxy).get("ACT")).toEqual({ payload: "x" });
		expect(gets).toBe(0);
		expect(hasCalls).toBe(0);
	});

	it(`throws ${ACTION_PARAMETER_UNBOUNDED} on a revoked Proxy instead of TypeError`, () => {
		const { proxy, revoke } = Proxy.revocable(
			{ params: { ACT: { payload: "x" } } },
			{},
		);
		revoke();
		try {
			parseActionParams(proxy);
			expect.unreachable("parse should fail closed on a revoked Proxy");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
			expect((error as Error).name).not.toBe("TypeError");
		}
	});

	it("fails closed on an 8k nest through parseActionParams", () => {
		const started = performance.now();
		try {
			parseActionParams({
				params: { ACT: { payload: nestArray(8_000) } },
			});
			expect.unreachable("production parse should fail closed on an 8k nest");
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
			expect((error as Error).name).not.toBe("RangeError");
		}
		expect(performance.now() - started).toBeLessThan(50);
	});

	it("preserves sparse holes through parseActionParams", () => {
		const payload: unknown[] = [];
		payload[2] = "x";
		const result = parseActionParams({
			params: { ACT: { payload } },
		}).get("ACT")?.payload as unknown[];
		expect(result).toHaveLength(3);
		expect(0 in result).toBe(false);
		expect(1 in result).toBe(false);
		expect(result[2]).toBe("x");
	});

	it("preserves __proto__ keys as inert own model data", () => {
		const params = parseActionParams(
			'{"params":{"ACT":{"__proto__":{"polluted":true},"payload":{"__proto__":{"nested":true}}}}}',
		).get("ACT") as ActionParameters;
		expect(Object.getPrototypeOf(params)).toBe(Object.prototype);
		expect(Object.hasOwn(params, "__proto__")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(params, "__proto__")?.value).toEqual(
			{ polluted: true },
		);
		expect((params as Record<string, unknown>).polluted).toBeUndefined();

		const payload = params.payload as ActionParameters;
		expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
		expect(Object.hasOwn(payload, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(payload, "__proto__")?.value,
		).toEqual({ nested: true });
		expect((payload as Record<string, unknown>).nested).toBeUndefined();
	});

	it("shares the node budget across the whole params graph", () => {
		const left: unknown[] = [];
		const right: unknown[] = [];
		left[1_200] = "x";
		right[1_200] = "y";
		try {
			parseActionParams({
				params: { A: { p: left }, B: { p: right } },
			});
			expect.unreachable(
				"shared budget should fail closed across action slots",
			);
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(ACTION_PARAMETER_UNBOUNDED);
		}
	});
});

describe("validateActionParams", () => {
	it("does not swallow an over-budget JSON array during string coercion", () => {
		const action = {
			name: "ACT",
			parameters: [
				{
					name: "items",
					required: true,
					schema: { type: "array", items: { type: "string" } },
				},
			],
		} as Action;
		const value = `[${Array.from({ length: MAX_ACTION_PARAMETER_NODES + 1 }, () => '"x"').join(",")}]`;
		expect(() => validateActionParams(action, { items: value })).toThrowError(
			expect.objectContaining({ code: ACTION_PARAMETER_UNBOUNDED }),
		);
	});
});
