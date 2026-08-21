/** Exercises desktop tray config behavior with deterministic app-core test fixtures. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  hasKnownMacosStatusItemSceneRegression,
  resolveTrayClickAction,
  shouldAttachTrayMenu,
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
    expect(nativeDesktopSource).toContain(
      '{ id: "tray-show-window", label: "Open Eliza" }',
    );
    expect(nativeDesktopSource).toContain(
      '{ id: "quit", label: "Quit Eliza" }',
    );
    expect(nativeDesktopSource).toContain(
      "options.menu ?? FALLBACK_TRAY_MENU_ITEMS",
    );
  });
});

describe("shouldStartTrayFirst", () => {
  it("defaults the macOS assistant to tray-first", () => {
    expect(shouldStartTrayFirst({}, "darwin", [])).toBe(true);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "darwin", []),
    ).toBe(true);
    expect(
      shouldStartTrayFirst(
        { ELIZA_DESKTOP_EXPERIENCE: "workspace" },
        "darwin",
        [],
      ),
    ).toBe(false);
  });

  it("honors explicit legacy tray-first overrides on macOS", () => {
    for (const off of ["", "0", "false", "no"]) {
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

describe("hasKnownMacosStatusItemSceneRegression", () => {
  it("identifies the macOS 26.5 Control Center status-item failure", () => {
    expect(hasKnownMacosStatusItemSceneRegression("darwin", "25.5.0")).toBe(
      true,
    );
  });

  it("leaves unaffected kernels and platforms alone", () => {
    expect(hasKnownMacosStatusItemSceneRegression("darwin", "25.4.0")).toBe(
      false,
    );
    expect(hasKnownMacosStatusItemSceneRegression("darwin", "25.6.0")).toBe(
      false,
    );
    expect(hasKnownMacosStatusItemSceneRegression("win32", "25.5.0")).toBe(
      false,
    );
  });
});

describe("shouldEnableTrayPopover", () => {
  it("defaults off on macOS so the taskbar icon owns a native menu", () => {
    expect(shouldEnableTrayPopover({}, "darwin", [])).toBe(false);
  });

  it("allows the experimental popover when explicitly enabled", () => {
    expect(
      shouldEnableTrayPopover(
        { ELIZA_DESKTOP_TRAY_POPOVER: "1" },
        "darwin",
        [],
      ),
    ).toBe(true);
  });

  it("stays off on Windows/Linux (tracked follow-up)", () => {
    expect(shouldEnableTrayPopover({}, "win32", [])).toBe(false);
    expect(shouldEnableTrayPopover({}, "linux", [])).toBe(false);
  });

  it("stays off when the tray itself is disabled", () => {
    expect(
      shouldEnableTrayPopover(
        {
          ELIZA_DESKTOP_DISABLE_TRAY: "1",
          ELIZA_DESKTOP_TRAY_POPOVER: "1",
        },
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

describe("shouldAttachTrayMenu", () => {
  it("keeps native tray menus attached on non-macOS platforms", () => {
    expect(shouldAttachTrayMenu({}, "win32")).toBe(true);
    expect(shouldAttachTrayMenu({}, "linux")).toBe(true);
  });

  it("attaches a native menu on macOS by default", () => {
    expect(shouldAttachTrayMenu({}, "darwin")).toBe(true);
    expect(
      shouldAttachTrayMenu({ ELIZA_DESKTOP_TRAY_MENU: "0" }, "darwin"),
    ).toBe(false);
  });
});

describe("resolveTrayClickAction", () => {
  it("prioritizes the popover when configured", () => {
    expect(
      resolveTrayClickAction({
        popoverConfigured: true,
        windowVisible: true,
        windowFocused: true,
      }),
    ).toBe("toggle-popover");
  });

  it("hides a visible focused window", () => {
    expect(
      resolveTrayClickAction({
        popoverConfigured: false,
        windowVisible: true,
        windowFocused: true,
      }),
    ).toBe("hide-window");
  });

  it("summons the window when it is hidden or unfocused", () => {
    expect(
      resolveTrayClickAction({
        popoverConfigured: false,
        windowVisible: false,
        windowFocused: false,
      }),
    ).toBe("show-window");
    expect(
      resolveTrayClickAction({
        popoverConfigured: false,
        windowVisible: true,
        windowFocused: false,
      }),
    ).toBe("show-window");
  });
});
