/**
 * Deterministic unit coverage for the prompt/context text-normalization
 * helpers. Both functions are pure, so every case is an exact input/output
 * assertion.
 *
 * These build the text blocks that reach model prompts, so the coercion rules
 * are the contract: which values survive, which are silently dropped, and how a
 * nested value is rendered. The drops are the part worth pinning — a value that
 * disappears here disappears from the prompt with no error, and the rule is
 * "empty after coercion", not "falsy": `0` and `false` are kept while `{}`,
 * `null` and a whitespace-only string are not.
 */

import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import {
	flattenTextValues,
	MAX_TEXT_NORMALIZE_DEPTH,
	MAX_TEXT_NORMALIZE_EDGES,
	MAX_TEXT_NORMALIZE_NODES,
	TEXT_NORMALIZE_UNBOUNDED,
	toMultilineText,
} from "./text-normalize";

describe("flattenTextValues", () => {
	describe("strings", () => {
		it("trims and keeps a non-empty string", () => {
			expect(flattenTextValues("  hello  ")).toEqual(["hello"]);
		});

		it("drops an empty or whitespace-only string", () => {
			expect(flattenTextValues("")).toEqual([]);
			expect(flattenTextValues("   \n\t ")).toEqual([]);
		});
	});

	describe("nullish", () => {
		it("drops null and undefined, keeping their siblings", () => {
			expect(flattenTextValues(null)).toEqual([]);
			expect(flattenTextValues(undefined)).toEqual([]);
			expect(flattenTextValues([null, "a", undefined, "b"])).toEqual([
				"a",
				"b",
			]);
		});
	});

	describe("scalars", () => {
		it("keeps falsy-but-present scalars", () => {
			// The rule is "empty after coercion", not "falsy" — dropping these would
			// silently remove a real 0 or false from a prompt.
			expect(flattenTextValues(0)).toEqual(["0"]);
			expect(flattenTextValues(false)).toEqual(["false"]);
			expect(flattenTextValues([0, false])).toEqual(["0", "false"]);
		});

		it("stringifies other scalars", () => {
			expect(flattenTextValues(42)).toEqual(["42"]);
			expect(flattenTextValues(Number.NaN)).toEqual(["NaN"]);
			expect(flattenTextValues(true)).toEqual(["true"]);
		});
	});

	describe("arrays", () => {
		it("flattens arbitrarily nested arrays in order", () => {
			expect(flattenTextValues(["a", ["b", ["c", ["d"]]]])).toEqual([
				"a",
				"b",
				"c",
				"d",
			]);
		});

		it("yields nothing for an empty array or an array of empties", () => {
			expect(flattenTextValues([])).toEqual([]);
			expect(flattenTextValues([null, "", [], "  "])).toEqual([]);
		});
	});

	describe("objects", () => {
		it("renders each entry as `key: value`", () => {
			expect(flattenTextValues({ a: "1", b: "2" })).toEqual(["a: 1", "b: 2"]);
		});

		it("joins a nested collection into one entry with `, `", () => {
			expect(flattenTextValues({ tags: ["x", "y"] })).toEqual(["tags: x, y"]);
			expect(flattenTextValues({ outer: { inner: "v" } })).toEqual([
				"outer: inner: v",
			]);
		});

		it("drops an entry whose value coerces to nothing", () => {
			expect(flattenTextValues({ a: {}, b: null, c: "  ", d: [] })).toEqual([]);
			expect(flattenTextValues({ kept: "v", dropped: null })).toEqual([
				"kept: v",
			]);
		});

		it("keeps an entry whose value is a falsy scalar", () => {
			expect(flattenTextValues({ count: 0, on: false })).toEqual([
				"count: 0",
				"on: false",
			]);
		});

		it("handles circular objects and arrays without stack overflow", () => {
			const circularObj: Record<string, unknown> = { name: "agent" };
			circularObj.self = circularObj;
			expect(flattenTextValues(circularObj)).toEqual(["name: agent"]);

			const circularArr: unknown[] = ["first"];
			circularArr.push(circularArr);
			expect(flattenTextValues(circularArr)).toEqual(["first"]);
		});

		it("preserves repeated references that are not cycles", () => {
			const shared = { value: "kept" };

			expect(flattenTextValues({ first: shared, second: shared })).toEqual([
				"first: value: kept",
				"second: value: kept",
			]);
		});
	});

	describe("dates", () => {
		const timestamp = "2026-01-01T00:00:00.000Z";
		const date = new Date(timestamp);

		it("renders a Date as a deterministic ISO-8601 fragment", () => {
			expect(flattenTextValues(date)).toEqual([timestamp]);
		});

		it("preserves Dates nested in arrays and object properties", () => {
			expect(flattenTextValues(["created", date])).toEqual([
				"created",
				timestamp,
			]);
			expect(flattenTextValues({ createdAt: date })).toEqual([
				`createdAt: ${timestamp}`,
			]);
		});

		it("renders an invalid Date without throwing", () => {
			expect(flattenTextValues(new Date(Number.NaN))).toEqual(["Invalid Date"]);
		});

		it("recognizes Dates created in another JavaScript realm", () => {
			const crossRealmDate = runInNewContext(
				`new Date(${JSON.stringify(timestamp)})`,
			) as Date;

			expect(crossRealmDate instanceof Date).toBe(false);
			expect(flattenTextValues(crossRealmDate)).toEqual([timestamp]);
		});

		it("uses intrinsic Date operations instead of overridden methods", () => {
			class MisleadingDate extends Date {
				override getTime(): number {
					throw new Error("overridden getTime must not run");
				}

				override toISOString(): string {
					return "spoofed ISO value";
				}

				override toString(): string {
					return "spoofed string value";
				}
			}

			expect(flattenTextValues(new MisleadingDate(timestamp))).toEqual([
				timestamp,
			]);
			expect(flattenTextValues(new MisleadingDate(Number.NaN))).toEqual([
				"Invalid Date",
			]);
		});

		it("does not trust a spoofed Date toStringTag", () => {
			expect(
				flattenTextValues({
					[Symbol.toStringTag]: "Date",
					value: "kept",
				}),
			).toEqual(["value: kept"]);
		});
	});

	describe("non-plain objects have no enumerable own entries and are dropped", () => {
		// Map and Set do not have a canonical prompt representation, so they retain
		// the existing empty-object behavior rather than relying on their toString().
		it.each([
			["a Map", new Map([["k", "v"]])],
			["a Set", new Set(["a"])],
		])("drops %s", (_label, value) => {
			expect(flattenTextValues(value)).toEqual([]);
		});
	});
});

describe("toMultilineText", () => {
	it("joins the flattened fragments with newlines", () => {
		expect(toMultilineText({ a: "1", b: "2" })).toBe("a: 1\nb: 2");
		expect(toMultilineText(["x", ["y", "z"]])).toBe("x\ny\nz");
	});

	it("returns an empty string when nothing survives", () => {
		expect(toMultilineText(null)).toBe("");
		expect(toMultilineText([null, "  ", {}])).toBe("");
	});
});

describe("flattenTextValues budget", () => {
	function nestArray(depth: number): unknown {
		let value: unknown = "leaf";
		for (let i = 0; i < depth; i++) {
			value = [value];
		}
		return value;
	}

	it(`accepts a ${MAX_TEXT_NORMALIZE_DEPTH}-deep array nest`, () => {
		expect(flattenTextValues(nestArray(MAX_TEXT_NORMALIZE_DEPTH))).toEqual([
			"leaf",
		]);
	});

	it(`throws ${TEXT_NORMALIZE_UNBOUNDED} one past depth ${MAX_TEXT_NORMALIZE_DEPTH}`, () => {
		expect(() =>
			flattenTextValues(nestArray(MAX_TEXT_NORMALIZE_DEPTH + 1)),
		).toThrowError(ElizaError);
		try {
			flattenTextValues(nestArray(MAX_TEXT_NORMALIZE_DEPTH + 1));
		} catch (error) {
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(TEXT_NORMALIZE_UNBOUNDED);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it(`throws ${TEXT_NORMALIZE_UNBOUNDED} past ${MAX_TEXT_NORMALIZE_NODES} nodes`, () => {
		const siblings = Array.from(
			{ length: MAX_TEXT_NORMALIZE_NODES },
			(_, i) => `v${i}`,
		);
		expect(() => flattenTextValues(siblings)).toThrowError(ElizaError);
	});

	it("counts sparse array holes against the work budget", () => {
		const sparse = new Array(MAX_TEXT_NORMALIZE_EDGES + 1);
		expect(() => flattenTextValues(sparse)).toThrowError(
			expect.objectContaining({ code: TEXT_NORMALIZE_UNBOUNDED }),
		);
	});

	it("does not eagerly read object properties beyond the work budget", () => {
		let outOfBudgetGetterRead = false;
		const value: Record<string, unknown> = {};
		for (let index = 0; index < MAX_TEXT_NORMALIZE_NODES; index += 1) {
			value[`value${index}`] = "kept";
		}
		Object.defineProperty(value, "outOfBudget", {
			enumerable: true,
			get() {
				outOfBudgetGetterRead = true;
				return "must not be read";
			},
		});

		expect(() => flattenTextValues(value)).toThrowError(
			expect.objectContaining({ code: TEXT_NORMALIZE_UNBOUNDED }),
		);
		expect(outOfBudgetGetterRead).toBe(false);
	});

	it("does not RangeError a 20k array nest", () => {
		expect(() => flattenTextValues(nestArray(20_000))).toThrowError(ElizaError);
		try {
			flattenTextValues(nestArray(20_000));
		} catch (error) {
			expect((error as ElizaError).code).toBe(TEXT_NORMALIZE_UNBOUNDED);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});
});
