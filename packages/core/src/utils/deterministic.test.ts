/**
 * Deterministic helpers must be reproducible: the same seed always yields the
 * same RNG stream / shuffle / sample, and stableStringify must be key-order
 * independent. Reproducibility is what makes seeded tests and stable IDs work.
 */

import { describe, expect, it } from "vitest";
import {
	buildDeterministicSeed,
	createDeterministicRandom,
	deterministicPick,
	deterministicSample,
	deterministicShuffle,
	getDeterministicNames,
	hashStringToUint32,
	shortStringHash,
	stableStringify,
} from "./deterministic.ts";

describe("hashStringToUint32", () => {
	it("is a stable uint32 hash, input-sensitive", () => {
		expect(hashStringToUint32("")).toBe(0x811c9dc5);
		const h = hashStringToUint32("hello");
		expect(h).toBe(hashStringToUint32("hello"));
		expect(h).not.toBe(hashStringToUint32("world"));
		expect(Number.isInteger(h)).toBe(true);
		expect(h).toBeGreaterThanOrEqual(0);
		expect(h).toBeLessThan(2 ** 32);
	});
});

describe("shortStringHash", () => {
	it("preserves the compact trace-key hash contract", () => {
		expect(shortStringHash("")).toBe("1505");
		expect(shortStringHash("hello")).toBe("e2f5ecef");
		expect(shortStringHash("template")).toBe("ae5c6ff3");
	});
});

describe("createDeterministicRandom", () => {
	it("reproduces the same stream for the same seed, in [0,1)", () => {
		const seq = (s: string) => {
			const r = createDeterministicRandom(s);
			return [r(), r(), r()];
		};
		const a = seq("seed");
		expect(seq("seed")).toEqual(a);
		expect(a.every((n) => n >= 0 && n < 1)).toBe(true);
		expect(seq("other")).not.toEqual(a);
	});
});

describe("shuffle / sample / pick", () => {
	const items = [1, 2, 3, 4, 5];

	it("deterministicShuffle is a reproducible permutation", () => {
		const a = deterministicShuffle(items, "s");
		expect(deterministicShuffle(items, "s")).toEqual(a);
		expect([...a].sort((x, y) => x - y)).toEqual(items); // same multiset
	});

	it("deterministicSample respects count bounds and reproducibility", () => {
		expect(deterministicSample(items, 0, "s")).toEqual([]);
		expect(deterministicSample(items, 99, "s")).toHaveLength(5);
		const two = deterministicSample(items, 2, "s");
		expect(two).toHaveLength(2);
		expect(deterministicSample(items, 2, "s")).toEqual(two);
	});

	it("deterministicPick returns one reproducible element", () => {
		const p = deterministicPick(items, "s");
		expect(items).toContain(p);
		expect(deterministicPick(items, "s")).toBe(p);
		expect(deterministicPick([], "s")).toBeUndefined();
	});
});

describe("getDeterministicNames / buildDeterministicSeed", () => {
	it("getDeterministicNames yields N reproducible non-empty names", () => {
		const names = getDeterministicNames(3, "s");
		expect(names).toHaveLength(3);
		expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(
			true,
		);
		expect(getDeterministicNames(3, "s")).toEqual(names);
		expect(getDeterministicNames(0, "s")).toEqual([]);
	});

	it("buildDeterministicSeed is reproducible and skips nullish/empty parts", () => {
		const seed = buildDeterministicSeed("a", null, "b", undefined, "");
		expect(typeof seed).toBe("string");
		expect(buildDeterministicSeed("a", "b")).toBe(seed);
		expect(buildDeterministicSeed("b", "a")).not.toBe(seed);
	});
});

describe("stableStringify", () => {
	it("is independent of key insertion order", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe(
			stableStringify({ a: 2, b: 1 }),
		);
		expect(stableStringify({ a: { y: 1, x: 2 } })).toBe('{"a":{"x":2,"y":1}}');
		// arrays keep order.
		expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
	});
});

describe("stableStringify locale-independent ordering", () => {
  it("sorts object keys by UTF-16 code unit order, not localeCompare", () => {
    const input = { "Z": 1, "ä": 2, "a": 3 };
    expect(stableStringify(input)).toBe(
      stableStringify({ a: 3, "Z": 1, "ä": 2 }),
    );
  });
});
