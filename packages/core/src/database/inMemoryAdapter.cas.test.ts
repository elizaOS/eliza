/**
 * Verifies the shared compare-and-set value rules (cas-values.ts) and the core
 * InMemoryDatabaseAdapter's atomic cache CAS: insert-only-if-absent sentinel,
 * replace-if-equal deep equality, conflict `false`, and typed throws for
 * contract-misuse values. The in-memory map is synchronous, so atomicity here
 * is by construction — these tests pin the observable semantics every adapter
 * must match (the SQL adapters' real-atomicity tests live in plugin-sql).
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import {
	assertCasValue,
	CACHE_CAS_FAILED_CODE,
	CACHE_CAS_INVALID_VALUE_CODE,
	isRepresentableCacheValue,
	jsonValueEquals,
} from "./cas-values";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

function makeAdapter(): InMemoryDatabaseAdapter {
	// Cache keys are agent-scoped; use a stable test UUID via the constructor
	// default plus an explicit id so the scoping is visible in failures.
	const adapter = new InMemoryDatabaseAdapter(
		"00000000-0000-0000-0000-0000000000aa",
	);
	return adapter;
}

describe("isRepresentableCacheValue", () => {
	it("accepts JSON primitives, arrays, plain objects, and null", () => {
		expect(isRepresentableCacheValue(null)).toBe(true);
		expect(isRepresentableCacheValue("s")).toBe(true);
		expect(isRepresentableCacheValue(true)).toBe(true);
		expect(isRepresentableCacheValue(1)).toBe(true);
		expect(isRepresentableCacheValue([1, { a: "b" }])).toBe(true);
		expect(isRepresentableCacheValue({ a: [null, false] })).toBe(true);
	});

	it("rejects values that cannot survive a cache round-trip", () => {
		expect(isRepresentableCacheValue(undefined)).toBe(false);
		expect(isRepresentableCacheValue(Number.NaN)).toBe(false);
		expect(isRepresentableCacheValue(Number.POSITIVE_INFINITY)).toBe(false);
		expect(isRepresentableCacheValue(() => 1)).toBe(false);
		expect(isRepresentableCacheValue(1n)).toBe(false);
		expect(isRepresentableCacheValue(Symbol("x"))).toBe(false);
		// nested rejection
		expect(isRepresentableCacheValue({ a: undefined })).toBe(false);
		expect(isRepresentableCacheValue([Number.NaN])).toBe(false);
	});
});

describe("assertCasValue", () => {
	it("accepts undefined only for the expected role (absent sentinel)", () => {
		expect(() => assertCasValue(undefined, "expected")).not.toThrow();
		expect(() => assertCasValue(undefined, "replacement")).toThrow();
	});

	it("matches an expected null against a row storing JSON null", () => {
		expect(() => assertCasValue(null, "expected")).not.toThrow();
		expect(() => assertCasValue(null, "replacement")).not.toThrow();
	});
});

describe("jsonValueEquals", () => {
	it("is order-insensitive for object keys (jsonb parity)", () => {
		expect(jsonValueEquals({ b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
		expect(
			jsonValueEquals(
				{ y: [1, { c: null }], x: "s" },
				{ x: "s", y: [1, { c: null }] },
			),
		).toBe(true);
	});

	it("collapses numeric scale like jsonb", () => {
		expect(jsonValueEquals(1, 1.0)).toBe(true);
		expect(jsonValueEquals(0, -0)).toBe(true);
	});

	it("distinguishes lengths, keys, and types", () => {
		expect(jsonValueEquals([1, 2], [1, 2, 3])).toBe(false);
		expect(jsonValueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
		expect(jsonValueEquals({ a: 1 }, { b: 1 })).toBe(false);
		expect(jsonValueEquals("1", 1)).toBe(false);
		expect(jsonValueEquals(null, undefined)).toBe(false);
	});
});

describe("InMemoryDatabaseAdapter.compareAndSetCache", () => {
	it("inserts when expected is undefined and the key is absent", async () => {
		const adapter = makeAdapter();
		await expect(
			adapter.compareAndSetCache("k", undefined, { v: 1 }),
		).resolves.toBe(true);
		await expect(
			(await adapter.getCaches<{ v: number }>(["k"])).get("k"),
		).toEqual({ v: 1 });
	});

	it("returns false on insert-branch when the key already exists", async () => {
		const adapter = makeAdapter();
		await adapter.setCaches([{ key: "k", value: "original" }]);
		await expect(
			adapter.compareAndSetCache("k", undefined, "replacement"),
		).resolves.toBe(false);
		await expect((await adapter.getCaches(["k"])).get("k")).toBe("original");
	});

	it("replaces when expected deep-equals the stored value", async () => {
		const adapter = makeAdapter();
		await adapter.setCaches([{ key: "k", value: { a: [1, 2], b: "x" } }]);
		await expect(
			adapter.compareAndSetCache("k", { b: "x", a: [1, 2] }, "next"),
		).resolves.toBe(true);
		await expect((await adapter.getCaches(["k"])).get("k")).toBe("next");
	});

	it("returns false when the stored value differs", async () => {
		const adapter = makeAdapter();
		await adapter.setCaches([{ key: "k", value: { a: 1 } }]);
		await expect(
			adapter.compareAndSetCache("k", { a: 2 }, "next"),
		).resolves.toBe(false);
		await expect((await adapter.getCaches(["k"])).get("k")).toEqual({ a: 1 });
	});

	it("returns false when expected is supplied but the row is absent", async () => {
		const adapter = makeAdapter();
		await expect(
			adapter.compareAndSetCache("missing", { a: 1 }, "next"),
		).resolves.toBe(false);
		await expect(
			(await adapter.getCaches(["missing"])).get("missing"),
		).toBeUndefined();
	});

	it("replaces a row storing JSON null when expected is null", async () => {
		const adapter = makeAdapter();
		await adapter.setCaches([{ key: "k", value: null }]);
		await expect(adapter.compareAndSetCache("k", null, "next")).resolves.toBe(
			true,
		);
		await expect((await adapter.getCaches(["k"])).get("k")).toBe("next");
		// And a null expectation must NOT match an absent or non-null row.
		await expect(
			adapter.compareAndSetCache("absent", null, "next"),
		).resolves.toBe(false);
	});

	it("rejects jsonb-incompatible object KEYS (NUL and lone surrogate)", () => {
		expect(isRepresentableCacheValue({ "a\u0000b": 1 })).toBe(false);
		expect(isRepresentableCacheValue({ "\uD800key": 1 })).toBe(false);
		expect(isRepresentableCacheValue({ ok: { "nested\u0000": 1 } })).toBe(
			false,
		);
		// Clean keys at every nesting level still pass.
		expect(
			isRepresentableCacheValue({ ok: "v", nested: { deep: [1, "s"] } }),
		).toBe(true);
	});

	it("rejects non-representable replacement values", async () => {
		const adapter = makeAdapter();
		await expect(
			adapter.compareAndSetCache("k", undefined, Number.NaN),
		).rejects.toMatchObject({ code: CACHE_CAS_INVALID_VALUE_CODE });
	});

	it("is atomic within one process: concurrent single-shot CASes pick one winner", async () => {
		const adapter = makeAdapter();
		const results = await Promise.all(
			Array.from({ length: 32 }, (_, i) =>
				adapter.compareAndSetCache("race", undefined, i),
			),
		);
		expect(results.filter((r) => r)).toHaveLength(1);
	});

	it("is atomic on the replace branch: only the racer holding the current value wins", async () => {
		const adapter = makeAdapter();
		await adapter.setCaches([{ key: "k", value: 0 }]);
		const results = await Promise.all(
			Array.from({ length: 32 }, () => adapter.compareAndSetCache("k", 0, 1)),
		);
		expect(results.filter((r) => r)).toHaveLength(1);
		await expect((await adapter.getCaches(["k"])).get("k")).toBe(1);
	});
});

describe("compareAndSetCache storage failure", () => {
	it("throws the typed CAS error (not false) when a stored row is undecodable", async () => {
		const adapter = makeAdapter();
		// Plant a corrupt row directly in the private cache map; JSON.parse inside
		// compareAndSetCache must surface as a typed storage failure, never as a
		// conflict `false` — `false` is reserved exclusively for conflicts.
		(adapter as unknown as { cache: Map<string, string> }).cache.set(
			"corrupt",
			"{not-json",
		);
		const promise = adapter.compareAndSetCache("corrupt", "any", "next");
		await expect(promise).rejects.toMatchObject({
			name: "ElizaError",
			code: CACHE_CAS_FAILED_CODE,
		});
		await expect(promise).rejects.toBeInstanceOf(ElizaError);
		// Cause must be preserved so the caller can distinguish a storage fault
		// from a contract-misuse invalid value.
		await expect(promise).rejects.toMatchObject({
			cause: { name: "SyntaxError" },
		});
		// The corrupt row is NOT overwritten by the failed attempt.
		expect(
			(adapter as unknown as { cache: Map<string, string> }).cache.get(
				"corrupt",
			),
		).toBe("{not-json");
	});

	it("a healthy key still CASes after an earlier storage failure (no poison)", async () => {
		const adapter = makeAdapter();
		(adapter as unknown as { cache: Map<string, string> }).cache.set(
			"corrupt",
			"{not-json",
		);
		await expect(
			adapter.compareAndSetCache("corrupt", "any", "next"),
		).rejects.toMatchObject({
			code: CACHE_CAS_FAILED_CODE,
		});
		await expect(
			adapter.compareAndSetCache("fresh", undefined, { v: 1 }),
		).resolves.toBe(true);
		await expect(
			(await adapter.getCaches<{ v: number }>(["fresh"])).get("fresh"),
		).toEqual({
			v: 1,
		});
	});
});
