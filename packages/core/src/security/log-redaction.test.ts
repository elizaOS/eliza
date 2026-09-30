/**
 * Regression test: redaction clones must survive String()/template coercion.
 * A null-prototype clone throws "Cannot convert object to primitive value"
 * inside sinks that coerce log args (e.g. React DevTools' patched console
 * methods), which crashed the web startup screen in <AppProviderInner>.
 * __proto__ protection comes from defineProperty, not the prototype, so
 * plain-object clones stay safe and coercible.
 */
import { describe, expect, it } from "vitest";
import {
	REDACTION_FAILED_VALUE,
	redactLogValue,
	redactTrailingArgs,
} from "./log-redaction.js";

describe("log-redaction clone coercion", () => {
	it("redactTrailingArgs clones survive String() coercion", () => {
		const [clone] = redactTrailingArgs([{ phase: "restoring-session" }]);
		expect(() => String(clone)).not.toThrow();
		// Plain-object coercion: the default tag, not a throw. Sinks that
		// interpolate (React DevTools' patched console) survive; structured
		// sinks still get the full enumerable payload.
		expect(String(clone)).toBe("[object Object]");
		expect(clone).toEqual({ phase: "restoring-session" });
	});

	it("Map/Set clones survive String() coercion", () => {
		expect(() =>
			String(redactLogValue(new Map([["k", "v"]]), new WeakSet(), 0)),
		).not.toThrow();
		expect(() =>
			String(redactLogValue(new Set(["v"]), new WeakSet(), 0)),
		).not.toThrow();
	});

	it("still neutralizes an own __proto__ key", () => {
		const payload = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
		const clone = redactLogValue(payload, new WeakSet(), 0) as Record<
			string,
			unknown
		>;
		expect(Object.hasOwn(clone, "__proto__")).toBe(true);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(clone.ok).toBe(1);
	});

	it("still masks credential-named keys at depth", () => {
		const [clone] = redactTrailingArgs([
			{ nested: { apiKey: "sk-live-secret-value-12345" } },
		]);
		expect(JSON.stringify(clone)).not.toContain("sk-live-secret-value-12345");
		expect(JSON.stringify(clone)).toContain("[REDACTED]");
	});

	it("redactTrailingArgs still fails closed, never throws", () => {
		const evil = {};
		Object.defineProperty(evil, "boom", {
			enumerable: true,
			get() {
				throw new Error("getter");
			},
		});
		expect(() => redactTrailingArgs([evil])).not.toThrow();
		expect(redactTrailingArgs([evil])).toEqual([
			expect.objectContaining({ boom: REDACTION_FAILED_VALUE }),
		]);
	});
});
