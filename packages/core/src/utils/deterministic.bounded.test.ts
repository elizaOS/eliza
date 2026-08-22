/**
 * Bounded deterministic stringify: accessor, proxy, depth, breadth, string, and boundary guards.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors.ts";
import {
	MAX_STABLE_STRINGIFY_BYTES,
	MAX_STABLE_STRINGIFY_DEPTH,
	MAX_STABLE_STRINGIFY_EDGES,
	MAX_STABLE_STRINGIFY_NODES,
	STABLE_STRINGIFY_UNBOUNDED,
	stableStringifyBounded,
} from "./deterministic.ts";

function isUnbounded(error: unknown, reason?: string): boolean {
	if (!(error instanceof ElizaError)) return false;
	if (error.code !== STABLE_STRINGIFY_UNBOUNDED) return false;
	if (reason)
		return (error.context as Record<string, unknown>)?.reason === reason;
	return true;
}

describe("stableStringifyBounded", () => {
	it("spread-accessor: getter not invoked", () => {
		let invoked = false;
		const obj = {};
		Object.defineProperty(obj, "x", {
			get() {
				invoked = true;
				return 1;
			},
			enumerable: true,
			configurable: true,
		});
		expect(() => stableStringifyBounded(obj)).toThrow();
		try {
			stableStringifyBounded(obj);
		} catch (e) {
			expect(isUnbounded(e, "accessor")).toBe(true);
		}
		expect(invoked).toBe(false);

		const proxy = new Proxy(
			{ a: 1 },
			{
				get() {
					invoked = true;
					return 1;
				},
				ownKeys() {
					throw new Error("trap");
				},
			},
		);
		expect(() => stableStringifyBounded(proxy)).toThrow();
	});

	it("revoked/classification-proxy: traps translated", () => {
		const { proxy: revoked } = Proxy.revocable({ a: 1 }, {});
		// revoke
		// @ts-expect-error
		revoked; // keep ref
		const p = Proxy.revocable({ a: 1 }, {}).proxy;
		// revoke then access should throw bounded
		const rev = Proxy.revocable({ a: 1 }, {});
		rev.revoke();
		expect(() => stableStringifyBounded(rev.proxy)).toThrow();

		const poisoned = { a: 1 } as Record<string, unknown>;
		const d = new Date();
		// poison Symbol.toStringTag with accessor
		Object.defineProperty(d, Symbol.toStringTag, {
			get() {
				throw new Error("poison");
			},
			enumerable: false,
			configurable: true,
		});
		expect(() => stableStringifyBounded(d)).toThrow();
		try {
			stableStringifyBounded(d);
		} catch (e) {
			expect(isUnbounded(e, "date-brand")).toBe(true);
		}
	});

	it("deep-prototype: only own enumerable keys", () => {
		const proto = { inherited: 999 };
		const obj = Object.create(proto);
		(Object.assign(obj, { own: 1 }) as Record<string, unknown>).own = 1;
		// polluted __proto__ own key should be data, not prototype
		const polluted: Record<string, unknown> = {};
		Object.defineProperty(polluted, "__proto__", {
			value: { evil: 1 },
			writable: true,
			enumerable: true,
			configurable: true,
		});
		polluted.a = 1;
		const out = stableStringifyBounded(polluted);
		expect(out).toContain('"__proto__"');
		expect(out).toContain('"a":1');
		// inherited not serialized
		const out2 = stableStringifyBounded(obj);
		expect(out2).not.toContain("inherited");
		// null prototype
		const nullProto = Object.create(null) as Record<string, unknown>;
		nullProto.b = 2;
		nullProto.a = 1;
		expect(stableStringifyBounded(nullProto)).toBe('{"a":1,"b":2}');
	});

	it("huge-breadth: rejects before sort", () => {
		const big: Record<string, number> = {};
		for (let i = 0; i < MAX_STABLE_STRINGIFY_NODES + 10; i++) big[`k${i}`] = i;
		expect(() => stableStringifyBounded(big)).toThrow();
		try {
			stableStringifyBounded(big);
		} catch (e) {
			expect(
				isUnbounded(e, "keys") ||
					isUnbounded(e, "nodes") ||
					isUnbounded(e, "edges"),
			).toBe(true);
		}
	});

	it("huge-string: utf8-length precheck", () => {
		const huge = "a".repeat(MAX_STABLE_STRINGIFY_BYTES);
		expect(() => stableStringifyBounded(huge)).toThrow();
		try {
			stableStringifyBounded(huge);
		} catch (e) {
			expect(isUnbounded(e)).toBe(true);
		}
		const uni = "😀".repeat(400_000); // each is 2 code units, ~4 bytes utf8
		expect(() => stableStringifyBounded(uni)).toThrow();
	});

	it("sparse-array: holes become null", () => {
		const arr: unknown[] = [];
		arr[2] = 1;
		arr.length = 4;
		// holes at 0,1,3
		const out = stableStringifyBounded(arr);
		expect(out).toBe("[null,null,1,null]");
		// accessor index throws
		const arr2: unknown[] = [1, 2];
		Object.defineProperty(arr2, "0", {
			get() {
				throw new Error("x");
			},
			enumerable: true,
			configurable: true,
		});
		expect(() => stableStringifyBounded(arr2)).toThrow();
	});

	it("exact-boundaries and compat", () => {
		// depth limit
		let deep: unknown = 0;
		for (let i = 0; i < MAX_STABLE_STRINGIFY_DEPTH; i++) deep = { a: deep };
		expect(() => stableStringifyBounded(deep)).not.toThrow();
		let tooDeep: unknown = 0;
		for (let i = 0; i < MAX_STABLE_STRINGIFY_DEPTH + 2; i++)
			tooDeep = { a: tooDeep };
		expect(() => stableStringifyBounded(tooDeep)).toThrow();
		try {
			stableStringifyBounded(tooDeep);
		} catch (e) {
			expect(isUnbounded(e, "depth")).toBe(true);
		}

		// byte-for-byte compat
		expect(stableStringifyBounded({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
		const d = new Date("2026-01-01T00:00:00.000Z");
		expect(stableStringifyBounded(d)).toBe('"2026-01-01T00:00:00.000Z"');
		expect(stableStringifyBounded({ z: 1, ä: 2, B: 3, a: 4 })).toBe(
			'{"B":3,"a":4,"z":1,"ä":2}',
		);
	});
});
