import { describe, expect, it } from "vitest";
import { shouldCreateDesktopTray } from "./desktop-tray-config";

describe("desktop tray config", () => {
	it("creates the desktop tray by default", () => {
		expect(shouldCreateDesktopTray({})).toBe(true);
	});

	it("supports an explicit negative tray flag", () => {
		expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_TRAY: "0" })).toBe(false);
		expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_TRAY: "false" })).toBe(
			false,
		);
	});

	it("supports an explicit disable flag", () => {
		expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_DISABLE_TRAY: "1" })).toBe(
			false,
		);
<<<<<<< HEAD
		expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_DISABLE_TRAY: "yes" })).toBe(
			false,
		);
=======
		expect(
			shouldCreateDesktopTray({ ELIZA_DESKTOP_DISABLE_TRAY: "yes" }),
		).toBe(false);
>>>>>>> origin/codex/fused-local-inference-latest-20260515
	});
});
