/**
 * Deterministic tests for the planner action-parameter walk. No live model:
 * the walker is the production toActionParameterValue used on untrusted
 * `{ params }` JSON.
 */
import { describe, expect, it } from "vitest";
import {
	ACTION_PARAMETER_UNBOUNDED,
	MAX_ACTION_PARAMETER_DEPTH,
	MAX_ACTION_PARAMETER_NODES,
	toActionParameterValue,
} from "./action-parameter-value";
import { ElizaError } from "./errors";

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
			expect(String((error as Error).cause)).toMatch(/IsArray/);
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
});
