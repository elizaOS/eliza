import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shouldCreateDesktopTray } from "./desktop-tray-config";

const desktopNativePath = fileURLToPath(
	new URL("./native/desktop.ts", import.meta.url),
);

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
		expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_DISABLE_TRAY: "yes" })).toBe(
			false,
		);
	});

	it("keeps a native Quit fallback while the renderer menu is unavailable", () => {
		const nativeDesktopSource = readFileSync(desktopNativePath, "utf8");

		expect(nativeDesktopSource).toContain("FALLBACK_TRAY_MENU_ITEMS");
		expect(nativeDesktopSource).toContain('{ id: "quit", label: "Quit" }');
		expect(nativeDesktopSource).toContain(
			"options.menu ?? FALLBACK_TRAY_MENU_ITEMS",
		);
	});
});
