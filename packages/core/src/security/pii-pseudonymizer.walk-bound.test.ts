/**
 * Walk-bound proofs for PseudonymSession.substituteInValue / restoreInValue
 * and collectPiiPromptText. Origin develop recursed with Object.entries and
 * no depth/cycle/width/byte cap. Overlay fail-closes with PII_PSEUDONYM_UNBOUNDED.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import {
	collectPiiPromptText,
	isPiiPseudonymUnbounded,
	MAX_PII_PSEUDONYM_KEY_BYTES,
	MAX_PII_PSEUDONYM_WALK_BYTES,
	MAX_PII_PSEUDONYM_WALK_DEPTH,
	MAX_PII_PSEUDONYM_WALK_NODES,
	PII_PSEUDONYM_UNBOUNDED,
	PseudonymSession,
} from "./pii-pseudonymizer";

function nest(depth: number): unknown {
	let value: unknown = { leaf: "ok" };
	for (let i = 0; i < depth; i += 1) {
		value = { a: value };
	}
	return value;
}

function expectUnbounded(run: () => unknown): unknown {
	try {
		run();
		throw new Error("expected PII_PSEUDONYM_UNBOUNDED");
	} catch (error) {
		expect(isPiiPseudonymUnbounded(error)).toBe(true);
		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe(PII_PSEUDONYM_UNBOUNDED);
		expect(error).not.toBeInstanceOf(RangeError);
		return error;
	}
}

describe("pii-pseudonymizer walk bound", () => {
	it("still swaps and restores honest nested params", () => {
		const session = new PseudonymSession({ salt: "walk-bound" });
		session.learnSpans("email Dana Whitfield at Acme", [
			{ value: "Dana Whitfield", kind: "person", start: 6, end: 20 },
		]);
		const payload = { a: [{ b: { c: ["email Dana Whitfield"] } }] };
		const swapped = session.substituteInValue(payload);
		expect(JSON.stringify(swapped)).not.toContain("Dana Whitfield");
		expect(session.restoreInValue(swapped)).toEqual(payload);
	});

	it("honest depth below the cap still closes", () => {
		const session = new PseudonymSession({ salt: "walk-bound" });
		const value = nest(8);
		expect(session.substituteInValue(value)).toEqual(value);
		expect(MAX_PII_PSEUDONYM_WALK_DEPTH).toBeGreaterThan(8);
	});

	it("accepts the exact depth boundary and rejects the next container", () => {
		const session = new PseudonymSession({ salt: "walk-bound" });
		expect(
			session.substituteInValue(nest(MAX_PII_PSEUDONYM_WALK_DEPTH)),
		).toEqual(nest(MAX_PII_PSEUDONYM_WALK_DEPTH));
		expect(() =>
			session.substituteInValue(nest(MAX_PII_PSEUDONYM_WALK_DEPTH + 1)),
		).toThrow(expect.objectContaining({ code: PII_PSEUDONYM_UNBOUNDED }));
		expect(() =>
			session.restoreInValue(nest(MAX_PII_PSEUDONYM_WALK_DEPTH + 1)),
		).toThrow(expect.objectContaining({ code: PII_PSEUDONYM_UNBOUNDED }));
	});

	it("fail-closes on a cyclic graph instead of RangeError", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).substituteInValue(cyclic),
		);
	});

	it("fail-closes restoreInValue on a cyclic graph", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).restoreInValue(cyclic),
		);
	});

	it("fail-closes on a JSON.parse-accepted 20000-deep nest", () => {
		let raw = '{"leaf":"ok"}';
		for (let i = 0; i < 20_000; i += 1) {
			raw = `{"a":${raw}}`;
		}
		const parsed = JSON.parse(raw) as unknown;
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).substituteInValue(parsed),
		);
	});

	it("fail-closes on accessor-bearing objects", () => {
		let getterCalls = 0;
		const value: Record<string, unknown> = {};
		Object.defineProperty(value, "token", {
			enumerable: true,
			get() {
				getterCalls += 1;
				return "Dana Whitfield";
			},
		});
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).substituteInValue(value),
		);
		expect(getterCalls).toBe(0);
	});

	it("wraps revoked root array proxies with the typed error and preserves cause", () => {
		const { proxy, revoke } = Proxy.revocable([], {});
		revoke();
		const error = expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).substituteInValue(proxy),
		) as Error;
		expect(error.cause).toBeInstanceOf(TypeError);
	});

	it("wraps revoked child array proxies with the typed error and preserves cause", () => {
		const { proxy, revoke } = Proxy.revocable([], {});
		revoke();
		const error = expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).restoreInValue({
				child: proxy,
			}),
		) as Error;
		expect(error.cause).toBeInstanceOf(TypeError);
	});

	it("does not invoke hostile prototype reflection", () => {
		let prototypeCalls = 0;
		const value = new Proxy(
			{ name: "Dana Whitfield" },
			{
				getPrototypeOf() {
					prototypeCalls += 1;
					throw new Error("prototype trap");
				},
			},
		);
		const session = new PseudonymSession({ salt: "walk-bound" });
		session.learnSpans("Dana Whitfield", [
			{ value: "Dana Whitfield", kind: "person", start: 0, end: 14 },
		]);
		const swapped = session.substituteInValue(value) as Record<string, unknown>;
		expect(prototypeCalls).toBe(0);
		expect(swapped.name).not.toBe("Dana Whitfield");
	});

	it("walks null-prototype, class, and custom-prototype records", () => {
		class Payload {
			name = "Dana Whitfield";
		}
		const values = [
			Object.assign(Object.create(null), { name: "Dana Whitfield" }),
			new Payload(),
			Object.assign(Object.create({ inherited: "Dana Whitfield" }), {
				name: "Dana Whitfield",
			}),
		];
		const session = new PseudonymSession({ salt: "walk-bound" });
		session.learnSpans("Dana Whitfield", [
			{ value: "Dana Whitfield", kind: "person", start: 0, end: 14 },
		]);
		for (const value of values) {
			const swapped = session.substituteInValue(value) as Record<
				string,
				unknown
			>;
			expect(swapped.name).not.toBe("Dana Whitfield");
			expect(Object.hasOwn(swapped, "inherited")).toBe(false);
			expect(session.restoreInValue(swapped)).toMatchObject({
				name: "Dana Whitfield",
			});
		}
	});

	it("rejects a hostile length accessor without invoking the get trap", () => {
		let lengthGets = 0;
		const value = new Proxy([], {
			getOwnPropertyDescriptor(target, key) {
				if (key === "length") {
					return {
						configurable: true,
						enumerable: false,
						get() {
							lengthGets += 1;
							throw new Error("length trap");
						},
					};
				}
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get(target, key, receiver) {
				if (key === "length") {
					lengthGets += 1;
					throw new Error("length trap");
				}
				return Reflect.get(target, key, receiver);
			},
		});
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).substituteInValue(value),
		);
		expect(lengthGets).toBe(0);
	});

	it("rejects huge sparse arrays before numeric descriptor inspection", () => {
		let numericDescriptorCalls = 0;
		const sparse = new Proxy(new Array(MAX_PII_PSEUDONYM_WALK_NODES), {
			getOwnPropertyDescriptor(target, key) {
				if (typeof key === "string" && /^\d+$/.test(key)) {
					numericDescriptorCalls += 1;
				}
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).substituteInValue(sparse),
		);
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).restoreInValue(sparse),
		);
		expect(numericDescriptorCalls).toBe(0);
	});

	it("preserves sparse holes separately from explicit undefined", () => {
		const session = new PseudonymSession({ salt: "walk-bound" });
		session.learnSpans("token Dana Whitfield", [
			{ value: "Dana Whitfield", kind: "person", start: 6, end: 20 },
		]);
		const value = new Array<unknown>(4);
		value[1] = undefined;
		value[3] = "Dana Whitfield";
		const swapped = session.substituteInValue(value);
		expect(0 in swapped).toBe(false);
		expect(1 in swapped).toBe(true);
		expect(2 in swapped).toBe(false);
		expect(3 in swapped).toBe(true);
		expect(swapped[3]).not.toBe("Dana Whitfield");
		const restored = session.restoreInValue(swapped);
		expect(0 in restored).toBe(false);
		expect(1 in restored).toBe(true);
		expect(restored[3]).toBe("Dana Whitfield");
	});

	it("accepts the exact aggregate slot boundary and rejects over-budget", () => {
		const exact = new Array(MAX_PII_PSEUDONYM_WALK_NODES - 1);
		const session = new PseudonymSession({ salt: "walk-bound" });
		const swapped = session.substituteInValue(exact);
		expect(swapped).toHaveLength(MAX_PII_PSEUDONYM_WALK_NODES - 1);
		expect(0 in swapped).toBe(false);
		expect(session.restoreInValue(exact)).toHaveLength(
			MAX_PII_PSEUDONYM_WALK_NODES - 1,
		);
		expectUnbounded(() =>
			session.substituteInValue(new Array(MAX_PII_PSEUDONYM_WALK_NODES)),
		);
		expectUnbounded(() =>
			session.restoreInValue(new Array(MAX_PII_PSEUDONYM_WALK_NODES)),
		);
	});

	it("does not execute inherited or own array accessors", () => {
		let getterCalls = 0;
		const inherited = Object.create(Array.prototype) as unknown[];
		Object.defineProperty(inherited, "0", {
			get() {
				getterCalls += 1;
				return "Dana Whitfield";
			},
		});
		const value = new Array<unknown>(2);
		Object.setPrototypeOf(value, inherited);
		Object.defineProperty(value, "1", {
			enumerable: true,
			get() {
				getterCalls += 1;
				return "Dana Whitfield";
			},
		});
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).restoreInValue(value),
		);
		expect(getterCalls).toBe(0);
	});

	it("keeps __proto__ as an inert own data property", () => {
		const session = new PseudonymSession({ salt: "walk-bound" });
		session.learnSpans("token Dana Whitfield", [
			{ value: "Dana Whitfield", kind: "person", start: 6, end: 20 },
		]);
		const value: Record<string, unknown> = {};
		Object.defineProperty(value, "__proto__", {
			enumerable: true,
			value: "Dana Whitfield",
		});
		const swapped = session.substituteInValue(value);
		expect(Object.getPrototypeOf(swapped)).toBe(Object.prototype);
		expect(Object.hasOwn(swapped, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(swapped, "__proto__")?.value,
		).not.toBe("Dana Whitfield");
		expect(session.restoreInValue(swapped)).toEqual(value);
	});

	it("permits a shared acyclic object on sibling paths for substitute and restore", () => {
		const shared = { token: "plain" };
		const value = { left: shared, right: shared };
		const session = new PseudonymSession({ salt: "walk-bound" });
		expect(session.substituteInValue(value)).toEqual(value);
		expect(session.restoreInValue(value)).toEqual(value);
	});

	it("charges wide object keys before descriptor scanning", () => {
		let descriptorCalls = 0;
		const value = new Proxy(
			{},
			{
				ownKeys() {
					return Array.from(
						{ length: MAX_PII_PSEUDONYM_WALK_NODES },
						(_, index) => `k${index}`,
					);
				},
				getOwnPropertyDescriptor() {
					descriptorCalls += 1;
					return { configurable: true, enumerable: true, value: "x" };
				},
			},
		);
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).substituteInValue(value),
		);
		expectUnbounded(() =>
			new PseudonymSession({ salt: "walk-bound" }).restoreInValue(value),
		);
		expect(descriptorCalls).toBe(0);
	});

	it("accepts the exact string-byte budget and rejects one extra unit", () => {
		const session = new PseudonymSession({ salt: "walk-bound" });
		const exact = "x".repeat(MAX_PII_PSEUDONYM_WALK_BYTES);
		expect(session.substituteInValue(exact)).toBe(exact);
		expect(session.restoreInValue(exact)).toBe(exact);
		expectUnbounded(() =>
			session.substituteInValue("x".repeat(MAX_PII_PSEUDONYM_WALK_BYTES + 1)),
		);
		expectUnbounded(() =>
			session.restoreInValue("x".repeat(MAX_PII_PSEUDONYM_WALK_BYTES + 1)),
		);
	});

	it("accepts the exact key-byte budget and rejects a longer key", () => {
		const session = new PseudonymSession({ salt: "walk-bound" });
		const exactKey = "k".repeat(MAX_PII_PSEUDONYM_KEY_BYTES);
		const exact = { [exactKey]: "ok" };
		expect(session.substituteInValue(exact)).toEqual(exact);
		expect(session.restoreInValue(exact)).toEqual(exact);
		const over = { ["k".repeat(MAX_PII_PSEUDONYM_KEY_BYTES + 1)]: "ok" };
		expectUnbounded(() => session.substituteInValue(over));
		expectUnbounded(() => session.restoreInValue(over));
	});

	it("collectPiiPromptText uses the same bounded walker", () => {
		expect(collectPiiPromptText({ prompt: "hello" }, "sys")).toBe("hello\nsys");
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expectUnbounded(() => collectPiiPromptText(cyclic));
		expectUnbounded(() =>
			collectPiiPromptText({
				payload: new Array(MAX_PII_PSEUDONYM_WALK_NODES),
			}),
		);
		const { proxy, revoke } = Proxy.revocable([], {});
		revoke();
		const error = expectUnbounded(() =>
			collectPiiPromptText({ child: proxy }),
		) as Error;
		expect(error.cause).toBeInstanceOf(TypeError);
	});
});
