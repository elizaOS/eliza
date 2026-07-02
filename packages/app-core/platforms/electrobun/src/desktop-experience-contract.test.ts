import { describe, expect, it } from "vitest";
import {
  appendChatOverlayShellModeParam,
  resolveDesktopShellWindowPresentation,
  shouldStartBottomBar,
} from "./desktop-bottom-bar-config";
import {
  shouldCreateDesktopTray,
  shouldEnableTrayPopover,
  shouldStartTrayFirst,
} from "./desktop-tray-config";

/**
 * Pins the intended desktop experience documented in
 * `docs/desktop-window-lifecycle.md` (#10720): chat-first launch, tray on by
 * default, tray-first / popover opt-in, and kiosk overriding both. A regression
 * that flips any of these defaults fails here.
 */
describe("desktop experience contract — chat-first launch", () => {
  it("launches into the chromeless chat bottom bar by default", () => {
    expect(shouldStartBottomBar({}, [])).toBe(true);
  });

  it("honors the ELIZA_DESKTOP_BOTTOM_BAR kill switch", () => {
    for (const off of ["0", "false", "no", "off"]) {
      expect(shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: off }, [])).toBe(
        false,
      );
    }
  });

  it("kiosk mode overrides the bottom bar (env and argv)", () => {
    expect(shouldStartBottomBar({ ELIZAOS_SHELL_MODE: "kiosk" }, [])).toBe(
      false,
    );
    expect(shouldStartBottomBar({}, ["--shell-mode=kiosk"])).toBe(false);
  });

  it("tags the renderer URL so the chat-overlay shell renders", () => {
    const tagged = appendChatOverlayShellModeParam("http://localhost:2138/");
    expect(tagged).toContain("shellMode=chat-overlay");
  });

  it("presents the default window as a transparent, frameless bottom bar (macOS)", () => {
    const presentation = resolveDesktopShellWindowPresentation(
      {},
      [],
      "darwin",
    );
    expect(presentation.mode).toBe("bottom-bar");
    expect(presentation.titleBarStyle).toBe("hidden");
    expect(presentation.transparent).toBe(true);
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

  it("keeps tray-first and the popover opt-in (macOS)", () => {
    expect(shouldStartTrayFirst({}, "darwin", [])).toBe(false);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "darwin", []),
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

  it("gates tray-first and popover off non-macOS platforms", () => {
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "1" }, "win32", []),
    ).toBe(false);
    expect(
      shouldEnableTrayPopover({ ELIZA_DESKTOP_TRAY_POPOVER: "1" }, "linux", []),
    ).toBe(false);
  });
});
