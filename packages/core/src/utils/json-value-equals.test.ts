/**
 * Exercises the canonical `jsonValueEquals` predicate that every first-party
 * world-metadata compare-and-swap adapter must share (#23100 review: the
 * predicate was previously duplicated per-adapter, and duplicated conflict
 * predicates drift — the same CAS could conflict on Postgres while succeeding
 * in memory). Deterministic pure-function tests, no mocks.
 */
import { describe, expect, it } from "vitest";
import { jsonValueEquals } from "./json-value-equals";

describe("jsonValueEquals (world-metadata CAS snapshot equality)", () => {
	it("matches identical primitives and references", () => {
		expect(jsonValueEquals(1, 1)).toBe(true);
		expect(jsonValueEquals("a", "a")).toBe(true);
		expect(jsonValueEquals(null, null)).toBe(true);
		expect(jsonValueEquals(true, true)).toBe(true);
		const shared = { roles: {} };
		expect(jsonValueEquals(shared, shared)).toBe(true);
	});

	it("rejects different primitives", () => {
		expect(jsonValueEquals(1, 2)).toBe(false);
		expect(jsonValueEquals("a", "b")).toBe(false);
		expect(jsonValueEquals(null, undefined)).toBe(false);
		expect(jsonValueEquals(true, false)).toBe(false);
	});

	it("compares plain objects by value with key order insignificant", () => {
		expect(jsonValueEquals({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
		expect(jsonValueEquals({ a: 1 }, { a: 2 })).toBe(false);
		expect(jsonValueEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false);
	});

	it("treats undefined-valued keys as absent (JSON round-trip semantics)", () => {
		expect(jsonValueEquals({ a: 1, b: undefined }, { a: 1 })).toBe(true);
		expect(jsonValueEquals({ a: undefined }, {})).toBe(true);
		expect(jsonValueEquals({ a: 1 }, { a: 1, b: undefined })).toBe(true);
	});

	it("compares arrays element-wise and never equals an object", () => {
		expect(jsonValueEquals([1, 2, 3], [1, 2, 3])).toBe(true);
		expect(jsonValueEquals([1, 2], [2, 1])).toBe(false);
		expect(jsonValueEquals([1], { 0: 1 })).toBe(false);
		expect(jsonValueEquals([], [])).toBe(true);
	});

	it("recurses through nested structures", () => {
		const left = { roles: { u1: "ADMIN" }, tags: ["a", { b: 1 }] };
		const right = { tags: ["a", { b: 1 }], roles: { u1: "ADMIN" } };
		expect(jsonValueEquals(left, right)).toBe(true);
		expect(jsonValueEquals(left, { ...right, roles: { u1: "USER" } })).toBe(
			false,
		);
	});

	it("FAILS CLOSED for exotic values: distinct Dates are NOT equal", () => {
		// A Date is not a plain object: both enumerate zero own keys, so a
		// naive record-compare would call two DIFFERENT Dates equal and let a
		// role-write CAS silently proceed on an unverifiable snapshot. The
		// shared predicate must reject exotic shapes unless reference-equal.
		const a = new Date("2024-01-01T00:00:00.000Z");
		const b = new Date("2025-01-01T00:00:00.000Z");
		expect(jsonValueEquals(a, b)).toBe(false);
		expect(jsonValueEquals({ when: a }, { when: b })).toBe(false);
		expect(jsonValueEquals(a, a)).toBe(true);
	});

	it("FAILS CLOSED for other non-plain-object shapes (Map, class instance)", () => {
		expect(jsonValueEquals(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(
			false,
		);
		class Role {
			constructor(public role: string) {}
		}
		expect(jsonValueEquals(new Role("ADMIN"), new Role("ADMIN"))).toBe(false);
	});

	it("never deep-compares an exotic value against a plain object", () => {
		// {toJSON} trap: a plain object carrying toJSON is still a plain
		// object; a real Date against a plain object must not fall through to
		// a keys-compare that could report equality.
		expect(jsonValueEquals(new Date(0), {})).toBe(false);
		expect(jsonValueEquals({}, new Date(0))).toBe(false);
	});
});
