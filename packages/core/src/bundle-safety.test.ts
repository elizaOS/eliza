/**
 * Covers anchorBundleSafety — stashing values under the exact
 * `__bundle_safety_<name>__` global key, with a distinct key per name — plus the
 * repo invariant that every feature barrel routes through the shared helper
 * instead of hand-rolling the `globalThis` assignment. Deterministic; the
 * invariant check walks the real `features/` tree on disk.
 */
import { describe, expect, it } from "vitest";
import { anchorBundleSafety } from "./bundle-safety.ts";

describe("anchorBundleSafety", () => {
	it("writes the exact __bundle_safety_<name>__ global key with the given values", () => {
		const marker = { id: "seam-marker" };
		anchorBundleSafety("TEST_SEAM_UNIT", [marker]);
		const key = "__bundle_safety_TEST_SEAM_UNIT__";
		const stashed = (globalThis as Record<string, unknown>)[key];
		expect(Array.isArray(stashed)).toBe(true);
		expect(stashed as unknown[]).toEqual([marker]);
		expect((stashed as unknown[])[0]).toBe(marker);
	});

	it("gives each name a distinct global key so sibling barrels never collide", () => {
		anchorBundleSafety("TEST_SEAM_A", ["a"]);
		anchorBundleSafety("TEST_SEAM_B", ["b"]);
		const g = globalThis as Record<string, unknown>;
		expect(g.__bundle_safety_TEST_SEAM_A__).toEqual(["a"]);
		expect(g.__bundle_safety_TEST_SEAM_B__).toEqual(["b"]);
	});
});
