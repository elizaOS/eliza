import { describe, expect, it } from "vitest";
import { anchorBundleSafety } from "./bundle-safety.ts";

describe("anchorBundleSafety", () => {
	it("stashes values on a namespaced global key", () => {
		const values = [Symbol("a"), { x: 1 }];
		anchorBundleSafety("test-barrel", values);
		const g = globalThis as Record<string, unknown>;
		expect(g.__bundle_safety_test_barrel__).toBe(values);
	});

	it("uses unique keys per name (no collisions)", () => {
		anchorBundleSafety("barrel-a", [1]);
		anchorBundleSafety("barrel-b", [2]);
		const g = globalThis as Record<string, unknown>;
		expect(g.__bundle_safety_barrel_a__).toEqual([1]);
		expect(g.__bundle_safety_barrel_b__).toEqual([2]);
	});

	it("overwrites the same name key on re-anchor", () => {
		anchorBundleSafety("dup", ["old"]);
		anchorBundleSafety("dup", ["new"]);
		const g = globalThis as Record<string, unknown>;
		expect(g.__bundle_safety_dup__).toEqual(["new"]);
	});
});
