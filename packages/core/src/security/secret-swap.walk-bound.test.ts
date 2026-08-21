/**
 * Walk-bound proofs for SecretSwapSession.substituteInValue / restoreInValue.
 * Origin develop recursed with Object.entries and no depth/cycle cap, so a
 * cyclic graph or a 20k-deep nest that JSON.parse already accepted then
 * RangeError'd. Overlay fail-closes with SECRET_SWAP_UNBOUNDED.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import {
	isSecretSwapUnbounded,
	MAX_SECRET_SWAP_WALK_DEPTH,
	MAX_SECRET_SWAP_WALK_NODES,
	SECRET_SWAP_UNBOUNDED,
	SecretSwapSession,
} from "./secret-swap";

function nest(depth: number): unknown {
	let value: unknown = { leaf: "ok" };
	for (let i = 0; i < depth; i += 1) {
		value = { a: value };
	}
	return value;
}

describe("secret-swap walk bound", () => {
	it("still swaps and restores honest nested params", () => {
		const secret = "sk-live_walkbound_AbC123dEf456";
		const session = new SecretSwapSession();
		const payload = { a: [{ b: { c: [`token ${secret}`] } }] };
		const swapped = session.substituteInValue(payload);
		expect(JSON.stringify(swapped)).not.toContain(secret);
		expect(session.restoreInValue(swapped)).toEqual(payload);
	});

	it("honest depth below the cap still closes", () => {
		const session = new SecretSwapSession();
		const value = nest(8);
		expect(session.substituteInValue(value)).toEqual(value);
		expect(MAX_SECRET_SWAP_WALK_DEPTH).toBeGreaterThan(8);
	});

	it("accepts the exact depth boundary and rejects the next container", () => {
		const session = new SecretSwapSession();
		expect(session.substituteInValue(nest(MAX_SECRET_SWAP_WALK_DEPTH))).toEqual(
			nest(MAX_SECRET_SWAP_WALK_DEPTH),
		);
		expect(() =>
			session.substituteInValue(nest(MAX_SECRET_SWAP_WALK_DEPTH + 1)),
		).toThrow(expect.objectContaining({ code: SECRET_SWAP_UNBOUNDED }));
	});

	it("fail-closes on a cyclic graph instead of RangeError", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const session = new SecretSwapSession();
		try {
			session.substituteInValue(cyclic);
			throw new Error("expected SECRET_SWAP_UNBOUNDED");
		} catch (error) {
			expect(isSecretSwapUnbounded(error)).toBe(true);
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(SECRET_SWAP_UNBOUNDED);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it("fail-closes restoreInValue on a cyclic graph", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const session = new SecretSwapSession();
		try {
			session.restoreInValue(cyclic);
			throw new Error("expected SECRET_SWAP_UNBOUNDED");
		} catch (error) {
			expect(isSecretSwapUnbounded(error)).toBe(true);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it("fail-closes on a JSON.parse-accepted 20000-deep nest", () => {
		let raw = '{"leaf":"ok"}';
		for (let i = 0; i < 20_000; i += 1) {
			raw = `{"a":${raw}}`;
		}
		const parsed = JSON.parse(raw) as unknown;
		const session = new SecretSwapSession();
		try {
			session.substituteInValue(parsed);
			throw new Error("expected SECRET_SWAP_UNBOUNDED");
		} catch (error) {
			expect(isSecretSwapUnbounded(error)).toBe(true);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it("fail-closes on accessor-bearing objects", () => {
		let getterCalls = 0;
		const value: Record<string, unknown> = {};
		Object.defineProperty(value, "token", {
			enumerable: true,
			get() {
				getterCalls += 1;
				return "sk-live_getter";
			},
		});
		const session = new SecretSwapSession();
		try {
			session.substituteInValue(value);
			throw new Error("expected SECRET_SWAP_UNBOUNDED");
		} catch (error) {
			expect(isSecretSwapUnbounded(error)).toBe(true);
			expect(getterCalls).toBe(0);
		}
	});

	it("wraps revoked array proxies with the typed error and preserves cause", () => {
		const { proxy, revoke } = Proxy.revocable([], {});
		revoke();
		const session = new SecretSwapSession();
		try {
			session.substituteInValue(proxy);
			throw new Error("expected SECRET_SWAP_UNBOUNDED");
		} catch (error) {
			expect(isSecretSwapUnbounded(error)).toBe(true);
			expect((error as Error).cause).toBeInstanceOf(TypeError);
		}
	});

	it("does not invoke a hostile prototype trap", () => {
		const secret = "sk-live_proto_trap_AbC123dEf456";
		let prototypeCalls = 0;
		const value = new Proxy(
			{ token: secret },
			{
				getPrototypeOf() {
					prototypeCalls += 1;
					throw new Error("prototype trap");
				},
			},
		);
		const swapped = new SecretSwapSession().substituteInValue(value) as Record<
			string,
			unknown
		>;
		expect(prototypeCalls).toBe(0);
		expect(swapped.token).not.toBe(secret);
	});

	it("walks null-prototype, class, and custom-prototype data records", () => {
		const secret = "sk-live_records_AbC123dEf456";
		class Payload {
			token = secret;
		}
		const nullPrototype = Object.assign(Object.create(null), { token: secret });
		const customPrototype = Object.assign(
			Object.create({ inherited: secret }),
			{
				token: secret,
			},
		);
		const session = new SecretSwapSession();
		for (const value of [nullPrototype, new Payload(), customPrototype]) {
			const swapped = session.substituteInValue(value) as Record<
				string,
				unknown
			>;
			expect(swapped.token).not.toBe(secret);
			expect(Object.hasOwn(swapped, "inherited")).toBe(false);
			const restored = session.restoreInValue(swapped) as Record<
				string,
				unknown
			>;
			expect(restored.token).toBe(secret);
		}
	});

	it("rejects huge sparse arrays before numeric descriptor inspection", () => {
		let numericDescriptorCalls = 0;
		const sparse = new Proxy(new Array(MAX_SECRET_SWAP_WALK_NODES), {
			getOwnPropertyDescriptor(target, key) {
				if (typeof key === "string" && /^\\d+$/.test(key)) {
					numericDescriptorCalls += 1;
				}
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});
		const session = new SecretSwapSession();
		expect(() => session.substituteInValue(sparse)).toThrow(
			expect.objectContaining({ code: SECRET_SWAP_UNBOUNDED }),
		);
		expect(numericDescriptorCalls).toBe(0);
	});

	it("preserves sparse holes separately from explicit undefined", () => {
		const secret = "sk-live_sparse_AbC123dEf456";
		const value = new Array<unknown>(4);
		value[1] = undefined;
		value[3] = secret;
		const session = new SecretSwapSession();
		const swapped = session.substituteInValue(value);
		expect(0 in swapped).toBe(false);
		expect(1 in swapped).toBe(true);
		expect(2 in swapped).toBe(false);
		expect(3 in swapped).toBe(true);
		expect(swapped[3]).not.toBe(secret);
	});

	it("accepts the exact aggregate slot boundary", () => {
		const value = new Array(MAX_SECRET_SWAP_WALK_NODES - 1);
		const swapped = new SecretSwapSession().substituteInValue(value);
		expect(swapped).toHaveLength(MAX_SECRET_SWAP_WALK_NODES - 1);
		expect(0 in swapped).toBe(false);
		expect(MAX_SECRET_SWAP_WALK_NODES - 2 in swapped).toBe(false);
	});

	it("does not execute inherited or own array accessors", () => {
		let getterCalls = 0;
		const inherited = Object.create(Array.prototype) as unknown[];
		Object.defineProperty(inherited, "0", {
			get() {
				getterCalls += 1;
				return "sk-live_inherited";
			},
		});
		const value = new Array<unknown>(2);
		Object.setPrototypeOf(value, inherited);
		Object.defineProperty(value, "1", {
			enumerable: true,
			get() {
				getterCalls += 1;
				return "sk-live_own";
			},
		});
		const session = new SecretSwapSession();
		expect(() => session.restoreInValue(value)).toThrow(
			expect.objectContaining({ code: SECRET_SWAP_UNBOUNDED }),
		);
		expect(getterCalls).toBe(0);
	});

	it("keeps __proto__ as an inert own data property", () => {
		const value: Record<string, unknown> = {};
		Object.defineProperty(value, "__proto__", {
			enumerable: true,
			value: "sk-live_proto_AbC123dEf456",
		});
		const session = new SecretSwapSession();
		const swapped = session.substituteInValue(value);
		expect(Object.getPrototypeOf(swapped)).toBe(Object.prototype);
		expect(Object.hasOwn(swapped, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(swapped, "__proto__")?.value,
		).not.toBe(Object.getOwnPropertyDescriptor(value, "__proto__")?.value);
	});

	it("permits a shared acyclic object on sibling paths", () => {
		const shared = { token: "plain" };
		const value = { left: shared, right: shared };
		expect(new SecretSwapSession().substituteInValue(value)).toEqual(value);
	});

	it("charges wide object keys before descriptor scanning", () => {
		let descriptorCalls = 0;
		const value = new Proxy(
			{},
			{
				ownKeys() {
					return Array.from(
						{ length: MAX_SECRET_SWAP_WALK_NODES },
						(_, index) => `k${index}`,
					);
				},
				getOwnPropertyDescriptor() {
					descriptorCalls += 1;
					return { configurable: true, enumerable: true, value: "x" };
				},
			},
		);
		expect(() => new SecretSwapSession().substituteInValue(value)).toThrow(
			expect.objectContaining({ code: SECRET_SWAP_UNBOUNDED }),
		);
		expect(descriptorCalls).toBe(0);
	});
});
