import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  shouldCreateDesktopTray,
  shouldEnableTrayPopover,
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
  it("defaults ON (dockless) for macOS (#12184)", () => {
    expect(shouldStartTrayFirst({}, "darwin", [])).toBe(true);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "darwin", []),
    ).toBe(true);
  });

  it("honors the ELIZA_DESKTOP_TRAY_FIRST=0 kill switch on macOS", () => {
    for (const off of ["0", "false", "no"]) {
      expect(
        shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: off }, "darwin", []),
      ).toBe(false);
    }
  });

  it("stays off on non-macOS platforms even by default", () => {
    expect(shouldStartTrayFirst({}, "win32", [])).toBe(false);
    expect(shouldStartTrayFirst({}, "linux", [])).toBe(false);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "win32", []),
    ).toBe(false);
  });

  it("stays off when the tray itself is disabled", () => {
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_DISABLE_TRAY: "1" }, "darwin", []),
    ).toBe(false);
  });

  it("stays off in kiosk shell mode", () => {
    expect(
      shouldStartTrayFirst({ ELIZAOS_SHELL_MODE: "kiosk" }, "darwin", []),
    ).toBe(false);
  });
});

describe("shouldEnableTrayPopover", () => {
  it("is opt-in: off by default on macOS", () => {
    expect(shouldEnableTrayPopover({}, "darwin", [])).toBe(false);
  });

  it("enables on macOS when ELIZA_DESKTOP_TRAY_POPOVER is truthy", () => {
    expect(
      shouldEnableTrayPopover(
        { ELIZA_DESKTOP_TRAY_POPOVER: "1" },
        "darwin",
        [],
      ),
    ).toBe(true);
  });

  it("stays off on Windows/Linux (tracked follow-up) even when requested", () => {
    expect(
      shouldEnableTrayPopover({ ELIZA_DESKTOP_TRAY_POPOVER: "1" }, "win32", []),
    ).toBe(false);
    expect(
      shouldEnableTrayPopover({ ELIZA_DESKTOP_TRAY_POPOVER: "1" }, "linux", []),
    ).toBe(false);
  });

  it("stays off when the tray itself is disabled", () => {
    expect(
      shouldEnableTrayPopover(
        { ELIZA_DESKTOP_TRAY_POPOVER: "1", ELIZA_DESKTOP_DISABLE_TRAY: "1" },
        "darwin",
        [],
      ),
    ).toBe(false);
  });

  it("stays off in kiosk shell mode", () => {
    expect(
      shouldEnableTrayPopover({ ELIZA_DESKTOP_TRAY_POPOVER: "1" }, "darwin", [
        "--shell-mode=kiosk",
      ]),
    ).toBe(false);
  });
});
