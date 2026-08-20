/**
 * Walk-bound proofs for SecretSwapSession.substituteInValue / restoreInValue.
 * Origin develop recursed with Object.entries and no depth/cycle cap, so a
 * cyclic graph or a 20k-deep nest that JSON.parse already accepted then
 * RangeError'd. Overlay fail-closes with SECRET_SWAP_UNBOUNDED.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import {
	MAX_SECRET_SWAP_WALK_DEPTH,
	SECRET_SWAP_UNBOUNDED,
	SecretSwapSession,
	isSecretSwapUnbounded,
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
		const value: Record<string, unknown> = {};
		Object.defineProperty(value, "token", {
			enumerable: true,
			get() {
				return "sk-live_getter";
			},
		});
		const session = new SecretSwapSession();
		try {
			session.substituteInValue(value);
			throw new Error("expected SECRET_SWAP_UNBOUNDED");
		} catch (error) {
			expect(isSecretSwapUnbounded(error)).toBe(true);
		}
	});
});
