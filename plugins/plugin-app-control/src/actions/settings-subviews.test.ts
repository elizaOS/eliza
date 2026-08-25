/**
 * Unit tests for settings-subviews: validates addressable subviews lookup.
 */
import { describe, expect, it } from "vitest";
import { subviewsForView } from "./settings-subviews.ts";

describe("settings-subviews", () => {
	it("returns undefined for non-settings view IDs", () => {
		expect(subviewsForView("chat")).toBeUndefined();
		expect(subviewsForView("dashboard")).toBeUndefined();
		expect(subviewsForView("")).toBeUndefined();
	});

	it("returns list of subviews for settings view", () => {
		const subviews = subviewsForView("settings");
		expect(Array.isArray(subviews)).toBe(true);
		expect(subviews?.length).toBeGreaterThan(0);
		for (const s of subviews ?? []) {
			expect(typeof s.id).toBe("string");
			expect(typeof s.label).toBe("string");
		}
	});
});
