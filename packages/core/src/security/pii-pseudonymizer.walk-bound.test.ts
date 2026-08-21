/**
 * Walk-bound proofs for PseudonymSession.substituteInValue / restoreInValue.
 * Origin develop recursed with Object.entries and no depth/cycle cap, so a
 * cyclic graph RangeError'd immediately and a JSON.parse-accepted 40k-deep nest
 * then RangeError'd. Overlay fail-closes with PII_PSEUDONYM_UNBOUNDED.
 */
import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import {
	isPiiPseudonymUnbounded,
	MAX_PII_PSEUDONYM_WALK_DEPTH,
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

	it("fail-closes on a cyclic graph instead of RangeError", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const session = new PseudonymSession({ salt: "walk-bound" });
		try {
			session.substituteInValue(cyclic);
			throw new Error("expected PII_PSEUDONYM_UNBOUNDED");
		} catch (error) {
			expect(isPiiPseudonymUnbounded(error)).toBe(true);
			expect(error).toBeInstanceOf(ElizaError);
			expect((error as ElizaError).code).toBe(PII_PSEUDONYM_UNBOUNDED);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it("fail-closes restoreInValue on a cyclic graph", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const session = new PseudonymSession({ salt: "walk-bound" });
		try {
			session.restoreInValue(cyclic);
			throw new Error("expected PII_PSEUDONYM_UNBOUNDED");
		} catch (error) {
			expect(isPiiPseudonymUnbounded(error)).toBe(true);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it("fail-closes on a JSON.parse-accepted 20000-deep nest", () => {
		let raw = '{"leaf":"ok"}';
		for (let i = 0; i < 20_000; i += 1) {
			raw = `{"a":${raw}}`;
		}
		const parsed = JSON.parse(raw) as unknown;
		const session = new PseudonymSession({ salt: "walk-bound" });
		try {
			session.substituteInValue(parsed);
			throw new Error("expected PII_PSEUDONYM_UNBOUNDED");
		} catch (error) {
			expect(isPiiPseudonymUnbounded(error)).toBe(true);
			expect(error).not.toBeInstanceOf(RangeError);
		}
	});

	it("fail-closes on accessor-bearing objects", () => {
		const value: Record<string, unknown> = {};
		Object.defineProperty(value, "token", {
			enumerable: true,
			get() {
				return "Dana Whitfield";
			},
		});
		const session = new PseudonymSession({ salt: "walk-bound" });
		try {
			session.substituteInValue(value);
			throw new Error("expected PII_PSEUDONYM_UNBOUNDED");
		} catch (error) {
			expect(isPiiPseudonymUnbounded(error)).toBe(true);
		}
	});
});
