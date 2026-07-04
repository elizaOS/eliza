import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getAmbientSingleton,
	peekAmbientSingleton,
	setAmbientSingleton,
} from "./ambient-context";

const KEY = Symbol.for("elizaos.test.ambient-context.singleton");

afterEach(() => {
	delete (globalThis as Record<PropertyKey, unknown>)[KEY];
});

describe("ambient-context singleton", () => {
	it("creates the value once and reuses it across calls", () => {
		const factory = vi.fn(() => ({ id: "first" }));

		const a = getAmbientSingleton(KEY, factory);
		const b = getAmbientSingleton(KEY, factory);

		expect(a).toBe(b);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("stores the value on the shared global slot so duplicate copies agree", () => {
		const value = { id: "shared" };
		getAmbientSingleton(KEY, () => value);

		expect((globalThis as Record<PropertyKey, unknown>)[KEY]).toBe(value);
		expect(peekAmbientSingleton(KEY)).toBe(value);
	});

	it("setAmbientSingleton overrides the value everywhere immediately", () => {
		getAmbientSingleton(KEY, () => ({ id: "original" }));
		const override = { id: "override" };

		setAmbientSingleton(KEY, override);

		// A subsequent get returns the override, never re-running the factory.
		const factory = vi.fn(() => ({ id: "unused" }));
		expect(getAmbientSingleton(KEY, factory)).toBe(override);
		expect(factory).not.toHaveBeenCalled();
	});

	it("peek returns undefined before anything is stored", () => {
		expect(peekAmbientSingleton(KEY)).toBeUndefined();
	});
});
