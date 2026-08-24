/**
 * Deterministic unit tests for the advanced-capabilities evaluator barrel
 * (index.ts): importing the barrel must register its bundle-safety anchor on
 * `globalThis` under the documented per-barrel key, that anchor must cover
 * exactly the barrel's public export surface (no unanchored export a
 * Bun.build tree-shake could drop, no stale anchored binding), and every
 * anchored binding must be live rather than an empty-init stub — the failure
 * class behind the on-device ReferenceError incidents (#10727, #11030,
 * #11248, #11276). Real module init against real global state; no mocks.
 */
import { describe, expect, it } from "vitest";
import * as evaluators from "./index.ts";

const ANCHOR_KEY =
	"__bundle_safety_FEATURES_ADVANCED_CAPABILITIES_EVALUATORS_INDEX__";

function anchoredValues(): unknown[] {
	const stashed = (globalThis as Record<string, unknown>)[ANCHOR_KEY];
	expect(Array.isArray(stashed)).toBe(true);
	return stashed as unknown[];
}

describe("advanced-capabilities evaluators barrel", () => {
	it("registers its bundle-safety anchor on globalThis when imported", () => {
		const stashed = (globalThis as Record<string, unknown>)[ANCHOR_KEY];
		expect(Array.isArray(stashed)).toBe(true);
	});

	it("anchors every public export exactly once — none missing, none stale", () => {
		const anchored = anchoredValues();
		const exported = Object.values(evaluators);
		expect(anchored.length).toBe(exported.length);

		const leftover = new Map<unknown, number>();
		for (const value of anchored) {
			leftover.set(value, (leftover.get(value) ?? 0) + 1);
		}
		for (const value of exported) {
			const remaining = leftover.get(value) ?? 0;
			expect(remaining).toBeGreaterThan(0);
			if (remaining === 1) leftover.delete(value);
			else leftover.set(value, remaining - 1);
		}
		expect(leftover.size).toBe(0);
	});

	it("keeps every anchored binding live, never an empty-init stub", () => {
		for (const value of anchoredValues()) {
			expect(value).toBeDefined();
			expect(value).not.toBeNull();
		}
	});
});
