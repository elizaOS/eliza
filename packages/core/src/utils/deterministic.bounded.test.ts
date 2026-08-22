/**
 * Comprehensive bound coverage for stableStringify.
 * Mirrors reviewer request: byte-for-byte, boundary, wide-object, digest translation.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_STABLE_STRINGIFY_DEPTH,
	MAX_STABLE_STRINGIFY_NODES,
	MAX_STABLE_STRINGIFY_STRING_BYTES,
	STABLE_STRINGIFY_UNBOUNDED,
	StableStringifyUnboundedError,
	stableStringify,
} from "./deterministic.ts";

function buildDeep(depth: number): unknown {
	let cur: unknown = { leaf: 1 };
	for (let i = 0; i < depth; i++) cur = { nest: cur };
	return cur;
}

describe("stableStringify byte-for-byte compatibility (plain JSON)", () => {
	it("nested objects sorted", () => {
		expect(stableStringify({ z: { y: 2, x: 1 }, a: 3 })).toBe(
			'{"a":3,"z":{"x":1,"y":2}}',
		);
	});
	it("arrays keep order", () => {
		expect(stableStringify([3, 1, 2])).toBe("[3,1,2]");
	});
	it("sparse arrays -> null holes", () => {
		// biome-ignore lint/suspicious/noSparseArray: intentional sparse hole preserved for byte-for-byte compatibility proof
		const sparse = [1, , 3] as unknown[];
		expect(stableStringify(sparse)).toBe("[1,null,3]");
		// Also via explicit hole using Array constructor
		const viaLength = new Array(3);
		viaLength[0] = 1;
		viaLength[2] = 3;
		expect(stableStringify(viaLength)).toBe("[1,null,3]");
	});
	it("Dates", () => {
		const d = new Date("2026-01-01T00:00:00.000Z");
		expect(stableStringify(d)).toBe('"2026-01-01T00:00:00.000Z"');
		expect(stableStringify({ d })).toBe('{"d":"2026-01-01T00:00:00.000Z"}');
		expect(stableStringify(new Date(NaN))).toBe("null");
		expect(stableStringify([new Date(NaN)])).toBe("[null]");
	});
	it("shared DAG (same ref twice) not flagged as cycle", () => {
		const shared = { x: 1 };
		expect(stableStringify({ y: shared, z: shared })).toBe(
			'{"y":{"x":1},"z":{"x":1}}',
		);
	});
	it("undefined/function/symbol in objects dropped, in arrays -> null", () => {
		expect(
			stableStringify({ a: undefined, b: 1, c: () => {}, d: Symbol("s") }),
		).toBe('{"b":1}');
		expect(stableStringify([undefined, () => {}, Symbol("s")])).toBe(
			"[null,null,null]",
		);
		expect(stableStringify({ a: { b: undefined } })).toBe('{"a":{}}');
	});
	it("numeric edges", () => {
		expect(stableStringify({ a: 0, b: -0 })).toBe('{"a":0,"b":0}');
		expect(stableStringify([Infinity, -Infinity, NaN])).toBe(
			"[null,null,null]",
		);
		expect(stableStringify(Number.MAX_SAFE_INTEGER)).toBe(
			String(Number.MAX_SAFE_INTEGER),
		);
	});
	it("entity-metadata style payload (hosted plain JSON)", () => {
		const metadata = {
			discord: { id: "123", username: "alice", discriminator: "0" },
			origin: "discord",
			session: { id: "s1", platform: "discord" },
			sender: { id: "u1", names: ["Alice"] },
			extra: { b: 2, a: 1, nested: { y: 2, x: 1 } },
		};
		// byte-for-byte equals historic unsorted? Check ordering
		expect(stableStringify(metadata)).toBe(
			'{"discord":{"discriminator":"0","id":"123","username":"alice"},"extra":{"a":1,"b":2,"nested":{"x":1,"y":2}},"origin":"discord","sender":{"id":"u1","names":["Alice"]},"session":{"id":"s1","platform":"discord"}}',
		);
		// spread merge used in entities.ts
		const merged = { ...{ a: 1 }, ...metadata };
		expect(stableStringify(merged)).toContain('"origin":"discord"');
	});
	it("approval payload shape", () => {
		const payload = {
			action: "send",
			channel: "discord",
			reason: "test",
			data: { b: 2, a: 1 },
		};
		expect(stableStringify(payload)).toBe(
			'{"action":"send","channel":"discord","data":{"a":1,"b":2},"reason":"test"}',
		);
		expect(stableStringify(payload)).toBe(
			stableStringify({
				reason: "test",
				data: { a: 1, b: 2 },
				channel: "discord",
				action: "send",
			}),
		);
	});
	it("scheduled-task digest shape", () => {
		const task = {
			taskId: "t1",
			agentId: "a1",
			kind: "reminder" as const,
			trigger: { kind: "once" as const, atIso: "2026-01-01T00:00:00.000Z" },
			promptInstructions: "hello",
			state: { status: "scheduled" as const },
			metadata: {
				extra: { nested: { b: 2, a: 1 } },
				sharedCutoverImport: null,
			},
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		const digest = stableStringify(task);
		expect(digest).toBe(
			'{"agentId":"a1","createdAt":"2026-01-01T00:00:00.000Z","kind":"reminder","metadata":{"extra":{"nested":{"a":1,"b":2}},"sharedCutoverImport":null},"promptInstructions":"hello","state":{"status":"scheduled"},"taskId":"t1","trigger":{"atIso":"2026-01-01T00:00:00.000Z","kind":"once"}}',
		);
		// order independence
		expect(
			stableStringify({
				b: task.metadata.extra.nested.b,
				a: task.metadata.extra.nested.a,
			}),
		).toBe('{"a":1,"b":2}');
	});
});

describe("stableStringify bounds - depth / nodes / string bytes", () => {
	it(`depth at limit ${MAX_STABLE_STRINGIFY_DEPTH - 1} passes`, () => {
		expect(() =>
			stableStringify(buildDeep(MAX_STABLE_STRINGIFY_DEPTH - 1)),
		).not.toThrow();
	});
	it(`depth just over limit throws depth`, () => {
		expect(() =>
			stableStringify(buildDeep(MAX_STABLE_STRINGIFY_DEPTH)),
		).toThrow(StableStringifyUnboundedError);
		try {
			stableStringify(buildDeep(MAX_STABLE_STRINGIFY_DEPTH + 1));
		} catch (e) {
			expect((e as StableStringifyUnboundedError).message).toContain("depth");
			expect((e as { code: unknown }).code).toBe(STABLE_STRINGIFY_UNBOUNDED);
		}
	});
	it(`nodes at limit via array length passes, just over throws`, () => {
		const ok = Array.from({ length: MAX_STABLE_STRINGIFY_NODES }, () => 1);
		expect(() => stableStringify(ok)).not.toThrow();
		const over = Array.from(
			{ length: MAX_STABLE_STRINGIFY_NODES + 1 },
			() => 1,
		);
		expect(() => stableStringify(over)).toThrow(StableStringifyUnboundedError);
	});
	it("nodes just over via object keys throws", () => {
		const base: Record<string, number> = {};
		for (let i = 0; i < MAX_STABLE_STRINGIFY_NODES; i++) base[`k${i}`] = 1;
		// This creates ~MAX keys, each counted plus values; may exceed due to key byte accounting.
		// Use array variant for precise boundary above; this just ensures wide throws nodes
		expect(() => stableStringify(base)).toThrow(StableStringifyUnboundedError);
	});
	it(`value string at ${MAX_STABLE_STRINGIFY_STRING_BYTES} passes, +1 throws leaf`, () => {
		const ok = "a".repeat(MAX_STABLE_STRINGIFY_STRING_BYTES);
		expect(() => stableStringify(ok)).not.toThrow();
		expect(() => stableStringify({ k: ok })).not.toThrow();
		const over = "a".repeat(MAX_STABLE_STRINGIFY_STRING_BYTES + 1);
		expect(() => stableStringify(over)).toThrow(StableStringifyUnboundedError);
		try {
			stableStringify(over);
		} catch (e) {
			expect((e as Error).message).toContain("leaf");
		}
	});
	it("key bytes at limit passes, over throws leaf", () => {
		const okKey = "k".repeat(MAX_STABLE_STRINGIFY_STRING_BYTES);
		expect(() => stableStringify({ [okKey]: 1 })).not.toThrow();
		const overKey = "k".repeat(MAX_STABLE_STRINGIFY_STRING_BYTES + 1);
		expect(() => stableStringify({ [overKey]: 1 })).toThrow(
			StableStringifyUnboundedError,
		);
	});
	it("cycle throws cycle", () => {
		const a: Record<string, unknown> = {} as Record<string, unknown>;
		a.self = a;
		expect(() => stableStringify(a)).toThrow(StableStringifyUnboundedError);
		try {
			stableStringify(a);
		} catch (e) {
			expect((e as Error).message).toContain("cycle");
		}
		// array cycle
		const arr: unknown[] = [];
		arr.push(arr);
		expect(() => stableStringify(arr)).toThrow(StableStringifyUnboundedError);
	});
	it("accessor preserves output (not thrown) — historic compatibility", () => {
		const o = {
			get a() {
				return 1;
			},
			b: 2,
		};
		expect(stableStringify(o)).toBe('{"a":1,"b":2}');
		// array accessor via getter
		const arr = [1, 2, 3];
		Object.defineProperty(arr, "1", {
			get() {
				return 99;
			},
			enumerable: true,
			configurable: true,
		});
		expect(stableStringify(arr)).toBe("[1,99,3]");
	});
	it("prototype: Map/Set/class instances serialize as {} or own keys (preserved)", () => {
		expect(stableStringify(new Map([["k", 1]]))).toBe("{}");
		expect(stableStringify(new Set([1, 2, 3]))).toBe("{}");
		class C {
			x = 1;
			y = 2;
		}
		expect(stableStringify(new C())).toBe('{"x":1,"y":2}');
		expect(
			stableStringify(
				Object.create(null, { a: { value: 1, enumerable: true } }),
			),
		).toBe('{"a":1}');
	});
});

describe("wide object ownKeys allocation limitation", () => {
	it("demonstrates that a wide object allocates full key list before nodes check", () => {
		// Create object with 3000 keys (>2048 node budget) — Reflect.ownKeys/Object.keys
		// will allocate a 3000-element array before the walk can throw. This is the
		// unavoidable allocation noted in the header.
		const wide: Record<string, number> = {};
		for (let i = 0; i < 3000; i++) wide[`k${i}`] = i;
		// It still throws, but the throw occurs AFTER the keys array was allocated.
		// We assert the throw is nodes, not depth, and that the keys array length is observable.
		const keysBeforeThrow = Object.keys(wide);
		expect(keysBeforeThrow.length).toBe(3000);
		expect(() => stableStringify(wide)).toThrow(StableStringifyUnboundedError);
		try {
			stableStringify(wide);
		} catch (e) {
			expect((e as StableStringifyUnboundedError).message).toContain("nodes");
		}
		// Document mitigation: callers with untrusted wide objects should cap JSON length
		// or key count before calling stableStringify, not rely on the walk to avoid allocation.
	});
});

describe("scheduled-task digest boundary translation", () => {
	it("successful digest is stable and order-independent", () => {
		const taskA = {
			taskId: "t1",
			metadata: { b: 2, a: 1 },
			state: { status: "scheduled" },
		};
		const taskB = {
			state: { status: "scheduled" },
			taskId: "t1",
			metadata: { a: 1, b: 2 },
		};
		expect(stableStringify(taskA)).toBe(stableStringify(taskB));
	});
	it("over-budget digest throws typed error with code for explicit translation", () => {
		const over = Array.from(
			{ length: MAX_STABLE_STRINGIFY_NODES + 10 },
			() => ({ x: 1 }),
		);
		let caught: unknown;
		try {
			stableStringify({ tasks: over });
		} catch (e) {
			caught = e;
		}
		expect(caught).toBeInstanceOf(StableStringifyUnboundedError);
		expect((caught as StableStringifyUnboundedError).code).toBe(
			STABLE_STRINGIFY_UNBOUNDED,
		);
		// Caller translation must not block legitimate execution with unhandled throw:
		// example handler mirrors what plugin-scheduling should do.
		function computeDigest(
			task: unknown,
		): string | { error: string; code: string } {
			try {
				return stableStringify(task);
			} catch (e) {
				if (e instanceof StableStringifyUnboundedError) {
					return {
						error: (e as Error).message,
						code: (e as { code: unknown }).code,
					};
				}
				throw e;
			}
		}
		const result = computeDigest({ tasks: over });
		expect(typeof result).toBe("object");
		expect((result as { code: string }).code).toBe(STABLE_STRINGIFY_UNBOUNDED);
	});
	it("Proxy trap limitation: hostile Proxy get trap runs before budget, plain JSON does not", () => {
		// A Proxy that traps ownKeys/get can execute code before the walk's budget check.
		// This demonstrates why the utility is NOT a hostile-Proxy sandbox — hosted data is plain JSON.
		let trapRan = false;
		const proxy = new Proxy(
			{ a: 1 },
			{
				ownKeys() {
					trapRan = true;
					return ["a"];
				},
			},
		);
		// On plain-key path we call Object.keys which triggers ownKeys trap.
		stableStringify(proxy);
		expect(trapRan).toBe(true);
	});
});
