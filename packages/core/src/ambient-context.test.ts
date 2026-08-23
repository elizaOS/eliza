/**
 * Coverage for ambient-context.
 */
import { describe, expect, it } from "vitest";
import {
	getAmbientSingleton,
	peekAmbientSingleton,
	setAmbientSingleton,
} from "./ambient-context.js";

describe("ambient-context", () => {
	it("returns undefined for an unset singleton", () => {
		const key = Symbol("unset");
		expect(peekAmbientSingleton(key)).toBeUndefined();
	});

	it("returns the value after set", () => {
		const key = Symbol("set");
		const value = { n: 1 };
		setAmbientSingleton(key, value);
		expect(getAmbientSingleton(key, () => ({ n: 0 }))).toBe(value);
		expect(peekAmbientSingleton(key)).toBe(value);
	});

	it("does not call the factory when the singleton already exists", () => {
		const key = Symbol("existing");
		const value = { n: 2 };
		setAmbientSingleton(key, value);
		let factoryCalls = 0;
		const got = getAmbientSingleton(key, () => {
			factoryCalls += 1;
			return { n: 3 };
		});
		expect(got).toBe(value);
		expect(factoryCalls).toBe(0);
	});

	it("calls the factory exactly once on first get", () => {
		const key = Symbol("factory");
		let factoryCalls = 0;
		const first = getAmbientSingleton(key, () => {
			factoryCalls += 1;
			return { n: 4 };
		});
		const second = getAmbientSingleton(key, () => {
			factoryCalls += 1;
			return { n: 5 };
		});
		expect(first).toBe(second);
		expect(factoryCalls).toBe(1);
	});

	it("keeps keys isolated", () => {
		const a = Symbol("a");
		const b = Symbol("b");
		setAmbientSingleton(a, { tag: "a" });
		setAmbientSingleton(b, { tag: "b" });
		expect(peekAmbientSingleton(a)?.tag).toBe("a");
		expect(peekAmbientSingleton(b)?.tag).toBe("b");
	});
});
