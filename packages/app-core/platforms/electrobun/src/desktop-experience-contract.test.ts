/** Exercises desktop experience contract behavior with deterministic app-core test fixtures. */
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
 * `docs/desktop-window-lifecycle.md` (#10720): chat-first launch, tray,
 * tray-first mode, and the launcher popover on by default, with kiosk
 * overriding them. A regression that flips any of these defaults fails here.
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

  it("keeps Cloud-only installs in the bottom-bar host across first run and relaunch", () => {
    // The chat-overlay renderer owns first-run now: it expands the transparent
    // native host to full while onboarding is active, then returns it through
    // half/input to the resting pill. Starting the legacy full dashboard host
    // makes every later Dock/tray reopen repaint the wallpaper window.
    expect(shouldStartBottomBar({ ELIZA_DESKTOP_CLOUD_ONLY: "1" }, [])).toBe(
      true,
    );
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

  it("presents the default window as a transparent, frameless bottom bar on every desktop", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const presentation = resolveDesktopShellWindowPresentation(
        {},
        [],
        platform,
      );
      expect(presentation.mode).toBe("bottom-bar");
      expect(presentation.titleBarStyle).toBe("hidden");
      expect(presentation.transparent).toBe(true);
      expect(presentation.nativeShadow).toBe(false);
    }
  });

  it("presents the Linux chat pill over a transparent native window", () => {
    const presentation = resolveDesktopShellWindowPresentation({}, [], "linux");
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

  it("defaults dockless tray-first with the renderer popover OFF for macOS", () => {
    // #12184: dockless is now the resting macOS experience — pill + menu-bar
    // icon, no Dock icon until a full window opens.
    expect(shouldStartTrayFirst({}, "darwin", [])).toBe(true);
    expect(
      shouldStartTrayFirst({ ELIZA_DESKTOP_TRAY_FIRST: "0" }, "darwin", []),
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
