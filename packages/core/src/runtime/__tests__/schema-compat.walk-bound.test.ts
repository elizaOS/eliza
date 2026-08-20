/**
 * Fail-closed walk budget for `normalizeSchemaForCerebras`.
 * On origin develop the walker recursed with `Object.entries` and no
 * depth/cycle cap, so JSON.parse-legal 8k-deep `properties` nests and
 * cyclic `not` graphs RangeError'd. Overlay throws typed
 * `CEREBRAS_SCHEMA_UNBOUNDED` instead.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import {
	CEREBRAS_SCHEMA_UNBOUNDED,
	isCerebrasSchemaUnbounded,
	MAX_CEREBRAS_SCHEMA_WALK_DEPTH,
	normalizeSchemaForCerebras,
} from "../schema-compat";

function deepProperties(depth: number): Record<string, unknown> {
	let node: Record<string, unknown> = { type: "string" };
	for (let i = 0; i < depth; i++) {
		node = { type: "object", properties: { x: node } };
	}
	return node;
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
