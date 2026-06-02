import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  shouldCreateDesktopTray,
  shouldStartTrayFirst,
} from "./desktop-tray-config";

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

describe("shouldStartTrayFirst", () => {
  it("is opt-in: off by default even on macOS", () => {
    expect(shouldStartTrayFirst({}, "darwin", [])).toBe(false);
  });

  it("is enabled on macOS when ELIZA_DESKTOP_TRAY_FIRST is truthy", () => {
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "darwin", []),
    ).toBe(true);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "true" }, "darwin", []),
    ).toBe(true);
  });

  it("stays off on non-macOS platforms even when requested", () => {
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "win32", []),
    ).toBe(false);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "linux", []),
    ).toBe(false);
  });

  it("stays off when the tray itself is disabled", () => {
    expect(
      shouldStartTrayFirst(
        { ELIZA_DESKTOP_TRAY_FIRST: "1", ELIZA_DESKTOP_DISABLE_TRAY: "1" },
        "darwin",
        [],
      ),
    ).toBe(false);
  });

  it("stays off in kiosk shell mode", () => {
    expect(
      shouldStartTrayFirst(
        { ELIZA_DESKTOP_TRAY_FIRST: "1", ELIZAOS_SHELL_MODE: "kiosk" },
        "darwin",
        [],
      ),
    ).toBe(false);
  });
});
