import { describe, expect, it } from "vitest";
import { shouldUseHeadlessDesktopSmoke } from "./main-window-session";

describe("shouldUseHeadlessDesktopSmoke", () => {
	it("is disabled by default", () => {
		expect(shouldUseHeadlessDesktopSmoke({})).toBe(false);
	});

	it("accepts ELIZA_DESKTOP_HEADLESS_SMOKE=1", () => {
		expect(
			shouldUseHeadlessDesktopSmoke({
				ELIZA_DESKTOP_HEADLESS_SMOKE: "1",
			}),
		).toBe(true);
	});

	it("accepts ELIZA_DESKTOP_HEADLESS_SMOKE=true", () => {
		expect(
			shouldUseHeadlessDesktopSmoke({
				ELIZA_DESKTOP_HEADLESS_SMOKE: "true",
			}),
		).toBe(true);
	});

	it("treats explicit off values as disabled", () => {
		for (const value of ["0", "false", "no", "off"]) {
			expect(
				shouldUseHeadlessDesktopSmoke({
					ELIZA_DESKTOP_HEADLESS_SMOKE: value,
				}),
			).toBe(false);
		}
	});
});
