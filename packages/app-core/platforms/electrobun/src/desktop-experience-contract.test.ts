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
 * Pins the macOS assistant and cross-platform Workspace startup contracts while
 * preserving explicit legacy overrides and kiosk precedence.
 */
describe("desktop experience contract — startup", () => {
  it("defaults macOS to assistant and other platforms to Workspace", () => {
    expect(resolveDesktopExperience({}, "darwin")).toBe("macos-assistant");
    expect(resolveDesktopExperience({}, "win32")).toBe("workspace");
    expect(resolveDesktopExperience({}, "linux")).toBe("workspace");
    expect(shouldStartBottomBar({}, [], "darwin")).toBe(true);
    expect(shouldStartBottomBar({}, [], "win32")).toBe(false);
  });

  it("supports an explicit macOS Workspace experience", () => {
    expect(
      shouldStartBottomBar(
        { ELIZA_DESKTOP_EXPERIENCE: "workspace" },
        [],
        "darwin",
      ),
    ).toBe(false);
    expect(
      resolveDesktopShellWindowPresentation(
        { ELIZA_DESKTOP_EXPERIENCE: "workspace" },
        [],
        "darwin",
      ).mode,
    ).toBe("default");
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

  it("keeps Cloud-only macOS installs on the same assistant contract", () => {
    expect(
      shouldStartBottomBar({ ELIZA_DESKTOP_CLOUD_ONLY: "1" }, [], "darwin"),
    ).toBe(true);
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

  it("presents the macOS default as the transparent assistant pill", () => {
    const presentation = resolveDesktopShellWindowPresentation(
      {},
      [],
      "darwin",
    );
    expect(presentation.mode).toBe("bottom-bar");
    expect(presentation.titleBarStyle).toBe("hidden");
    expect(presentation.transparent).toBe(true);
    expect(presentation.nativeShadow).toBe(false);
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

  it("defaults macOS assistant to tray-first with an explicit Workspace opt-out", () => {
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
