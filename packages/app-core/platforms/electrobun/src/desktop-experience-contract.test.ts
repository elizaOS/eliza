/** Exercises normal full-app startup and optional desktop accessory surfaces. */
import { describe, expect, it } from "vitest";
import {
  appendChatOverlayShellModeParam,
  resolveDesktopShellWindowPresentation,
  shouldStartBottomBar,
} from "./desktop-bottom-bar-config";
import { resolveDesktopExperience } from "./desktop-experience-config";
import {
  shouldCreateDesktopTray,
  shouldEnableTrayPopover,
  shouldStartTrayFirst,
} from "./desktop-tray-config";

/**
 * Pins the normal cross-platform Workspace startup contract while preserving
 * the explicit macOS assistant, legacy overrides, and kiosk precedence.
 */
describe("desktop experience contract — startup", () => {
  it("defaults every desktop platform to the full Workspace", () => {
    expect(resolveDesktopExperience({}, "darwin")).toBe("workspace");
    expect(resolveDesktopExperience({}, "win32")).toBe("workspace");
    expect(resolveDesktopExperience({}, "linux")).toBe("workspace");
    expect(shouldStartBottomBar({}, [], "darwin")).toBe(false);
    expect(shouldStartBottomBar({}, [], "win32")).toBe(false);
  });

  it("supports an explicit macOS assistant experience", () => {
    expect(
      shouldStartBottomBar(
        { ELIZA_DESKTOP_EXPERIENCE: "macos-assistant" },
        [],
        "darwin",
      ),
    ).toBe(true);
    expect(
      resolveDesktopShellWindowPresentation(
        { ELIZA_DESKTOP_EXPERIENCE: "macos-assistant" },
        [],
        "darwin",
      ).mode,
    ).toBe("bottom-bar");
  });

  it("honors explicit legacy bottom-bar overrides", () => {
    for (const on of ["1", "true", "yes", "on"]) {
      expect(
        shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: on }, [], "linux"),
      ).toBe(true);
    }
    for (const off of ["", "0", "false", "no", "off"]) {
      expect(
        shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: off }, [], "darwin"),
      ).toBe(false);
    }
  });

  it("keeps Cloud-only macOS installs on the normal full-app contract", () => {
    expect(
      shouldStartBottomBar({ ELIZA_DESKTOP_CLOUD_ONLY: "1" }, [], "darwin"),
    ).toBe(false);
  });

  it("kiosk mode overrides the bottom bar (env and argv)", () => {
    expect(
      shouldStartBottomBar({ ELIZAOS_SHELL_MODE: "kiosk" }, [], "darwin"),
    ).toBe(false);
    expect(shouldStartBottomBar({}, ["--shell-mode=kiosk"], "darwin")).toBe(
      false,
    );
  });

  it("tags the renderer URL so the chat-overlay shell renders", () => {
    const tagged = appendChatOverlayShellModeParam("http://localhost:2138/");
    expect(tagged).toContain("shellMode=chat-overlay");
  });

  it("presents non-macOS defaults as an opaque normal application", () => {
    for (const platform of ["win32", "linux"] as const) {
      const presentation = resolveDesktopShellWindowPresentation(
        {},
        [],
        platform,
      );
      expect(presentation.mode).toBe("default");
      expect(presentation.titleBarStyle).toBe("default");
      expect(presentation.transparent).toBe(false);
      expect(presentation.nativeShadow).toBe(true);
    }
  });

  it("presents the macOS default as the opaque full application", () => {
    const presentation = resolveDesktopShellWindowPresentation(
      {},
      [],
      "darwin",
    );
    expect(presentation.mode).toBe("default");
    expect(presentation.titleBarStyle).toBe("hiddenInset");
    expect(presentation.transparent).toBe(false);
    expect(presentation.nativeShadow).toBe(true);
  });

  it("keeps the optional bottom bar transparent", () => {
    const presentation = resolveDesktopShellWindowPresentation(
      { ELIZA_DESKTOP_BOTTOM_BAR: "1" },
      [],
      "darwin",
    );
    expect(presentation.mode).toBe("bottom-bar");
    expect(presentation.titleBarStyle).toBe("hidden");
    expect(presentation.transparent).toBe(true);
  });

  it("keeps the full dashboard window opaque on macOS — transparency is the pill only (#12184)", () => {
    // A transparent full window over dark web content renders as a full-window
    // frosted-glass sheet; only the chromeless pill is transparent.
    const presentation = resolveDesktopShellWindowPresentation(
      { ELIZA_DESKTOP_BOTTOM_BAR: "0" },
      [],
      "darwin",
    );
    expect(presentation.mode).toBe("default");
    expect(presentation.transparent).toBe(false);
    expect(presentation.nativeShadow).toBe(true);
  });

  it("resolves kiosk presentation when requested", () => {
    const presentation = resolveDesktopShellWindowPresentation(
      { ELIZAOS_SHELL_MODE: "kiosk" },
      [],
      "darwin",
    );
    expect(presentation.mode).toBe("kiosk");
  });
});

describe("desktop experience contract — tray", () => {
  it("creates the tray by default", () => {
    expect(shouldCreateDesktopTray({})).toBe(true);
  });

  it("honors the tray kill switches", () => {
    expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_DISABLE_TRAY: "1" })).toBe(
      false,
    );
    expect(shouldCreateDesktopTray({ ELIZA_DESKTOP_TRAY: "0" })).toBe(false);
  });

  it("keeps the normal macOS app in the Dock and supports explicit assistant tray-first", () => {
    expect(shouldStartTrayFirst({}, "darwin", [])).toBe(false);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "darwin", []),
    ).toBe(true);
    expect(
      shouldStartTrayFirst(
        { ELIZA_DESKTOP_EXPERIENCE: "macos-assistant" },
        "darwin",
        [],
      ),
    ).toBe(true);
    expect(shouldEnableTrayPopover({}, "darwin", [])).toBe(false);
    expect(
      shouldEnableTrayPopover(
        { ELIZA_DESKTOP_TRAY_POPOVER: "1" },
        "darwin",
        [],
      ),
    ).toBe(true);
  });

  it("gates dockless and popover off non-macOS platforms", () => {
    expect(shouldStartTrayFirst({}, "win32", [])).toBe(false);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "win32", []),
    ).toBe(false);
    expect(shouldEnableTrayPopover({}, "linux", [])).toBe(false);
  });
});
