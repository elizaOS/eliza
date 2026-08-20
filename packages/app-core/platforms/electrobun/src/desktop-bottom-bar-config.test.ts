/** Exercises desktop bottom bar config behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import {
  AUTH_GATE_BOTTOM_BAR_HEIGHT,
  AUTH_GATE_BOTTOM_BAR_WIDTH,
  appendChatOverlayShellModeParam,
  computeBottomBarFrame,
  computeBottomBarSurfaceFrame,
  DEFAULT_BOTTOM_BAR_HEIGHT,
  DEFAULT_BOTTOM_BAR_WIDTH,
  EXPANDED_BOTTOM_BAR_HEIGHT,
  EXPANDED_BOTTOM_BAR_WIDTH,
  HOVER_BOTTOM_BAR_HEIGHT,
  HOVER_BOTTOM_BAR_WIDTH,
  isBottomBarSurfaceState,
  resolveBottomBarFrameSize,
  resolveDesktopShellWindowPresentation,
  shouldReanchorBottomBar,
  shouldStartBottomBar,
} from "./desktop-bottom-bar-config";

describe("desktop bottom-bar config", () => {
  describe("shouldStartBottomBar", () => {
    it("is ON by default (#10350: bottom bar is the resting desktop surface)", () => {
      expect(shouldStartBottomBar({}, [])).toBe(true);
    });

    it("stays ON for unset / empty / truthy values", () => {
      for (const value of ["1", "true", "yes", "on", " TRUE ", ""]) {
        expect(
          shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: value }, []),
        ).toBe(true);
      }
    });

    it("opts out via explicit falsy ELIZA_DESKTOP_BOTTOM_BAR (the kill switch)", () => {
      for (const value of ["0", "false", "no", "off", " OFF "]) {
        expect(
          shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: value }, []),
        ).toBe(false);
      }
    });

    it("never starts in kiosk shell mode (env or argv), even unset", () => {
      expect(shouldStartBottomBar({ ELIZAOS_SHELL_MODE: "kiosk" }, [])).toBe(
        false,
      );
      expect(shouldStartBottomBar({}, ["--shell-mode=kiosk"])).toBe(false);
    });
  });

  describe("appendChatOverlayShellModeParam", () => {
    it("adds shellMode=chat-overlay, preserving query + hash", () => {
      expect(
        appendChatOverlayShellModeParam("http://localhost:2138/?foo=1#/chat"),
      ).toBe("http://localhost:2138/?foo=1&shellMode=chat-overlay#/chat");
    });

    it("falls back to string concat for non-URL inputs", () => {
      expect(appendChatOverlayShellModeParam("not a url")).toBe(
        "not a url?shellMode=chat-overlay",
      );
      expect(appendChatOverlayShellModeParam("not a url?x=1")).toBe(
        "not a url?x=1&shellMode=chat-overlay",
      );
    });

    it("tags elizaOS appliance sessions for always-on voice", () => {
      expect(
        appendChatOverlayShellModeParam("http://localhost:2138/", {
          ELIZAOS_ALWAYS_ON_VOICE: "1",
        }),
      ).toContain("elizaOSAlwaysOnVoice=1");
    });
  });

  describe("computeBottomBarFrame", () => {
    it("pins a pill-sized hit area to the bottom center of the work area", () => {
      const frame = computeBottomBarFrame({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      });
      expect(frame.width).toBe(DEFAULT_BOTTOM_BAR_WIDTH);
      expect(frame.height).toBe(DEFAULT_BOTTOM_BAR_HEIGHT);
      expect(frame.x).toBe((1920 - DEFAULT_BOTTOM_BAR_WIDTH) / 2);
      expect(frame.y).toBe(1080 - DEFAULT_BOTTOM_BAR_HEIGHT);
    });

    it("respects work-area origin (multi-monitor offset)", () => {
      const frame = computeBottomBarFrame({
        x: 1920,
        y: 24,
        width: 1440,
        height: 900,
      });
      expect(frame.x).toBe(1920 + (1440 - DEFAULT_BOTTOM_BAR_WIDTH) / 2);
      expect(frame.width).toBe(DEFAULT_BOTTOM_BAR_WIDTH);
      expect(frame.y).toBe(24 + 900 - DEFAULT_BOTTOM_BAR_HEIGHT);
    });

    it("centers custom dimensions inside an optional margin", () => {
      const frame = computeBottomBarFrame(
        { x: 0, y: 0, width: 1000, height: 800 },
        { width: 600, height: 100, margin: 20 },
      );
      expect(frame.x).toBe(200);
      expect(frame.width).toBe(600);
      expect(frame.height).toBe(100);
      expect(frame.y).toBe(800 - 100 - 20);
    });

    it("clamps to a sane minimum height", () => {
      const frame = computeBottomBarFrame(
        { x: 0, y: 0, width: 1000, height: 800 },
        { height: 1 },
      );
      expect(frame.height).toBe(48);
    });

    it("resolves rest, hover preview, sign-in chip, and expanded sizes", () => {
      expect(resolveBottomBarFrameSize({ expanded: false })).toEqual({
        width: DEFAULT_BOTTOM_BAR_WIDTH,
        height: DEFAULT_BOTTOM_BAR_HEIGHT,
      });
      expect(
        resolveBottomBarFrameSize({ expanded: false, hovered: true }),
      ).toEqual({
        width: HOVER_BOTTOM_BAR_WIDTH,
        height: HOVER_BOTTOM_BAR_HEIGHT,
      });
      expect(
        resolveBottomBarFrameSize({ expanded: false, chip: true }),
      ).toEqual({
        width: AUTH_GATE_BOTTOM_BAR_WIDTH,
        height: AUTH_GATE_BOTTOM_BAR_HEIGHT,
      });
      expect(resolveBottomBarFrameSize({ expanded: true, chip: true })).toEqual(
        {
          width: EXPANDED_BOTTOM_BAR_WIDTH,
          height: EXPANDED_BOTTOM_BAR_HEIGHT,
        },
      );
      expect(
        resolveBottomBarFrameSize({
          expanded: false,
          chip: true,
          hovered: true,
        }),
      ).toEqual({
        width: AUTH_GATE_BOTTOM_BAR_WIDTH,
        height: AUTH_GATE_BOTTOM_BAR_HEIGHT,
      });
    });

    it("constrains the expanded chat hit area instead of spanning the display", () => {
      expect(
        computeBottomBarFrame(
          { x: 0, y: 24, width: 1_440, height: 900 },
          {
            width: EXPANDED_BOTTOM_BAR_WIDTH,
            height: EXPANDED_BOTTOM_BAR_HEIGHT,
          },
        ),
      ).toEqual({ x: 420, y: 104, width: 600, height: 820 });
    });
  });

  describe("computeBottomBarSurfaceFrame", () => {
    const workArea = { x: 100, y: 24, width: 1920, height: 1000 };

    it("keeps closed state in the resting taskbar strip", () => {
      expect(computeBottomBarSurfaceFrame(workArea, "CLOSED")).toEqual(
        computeBottomBarFrame(workArea),
      );
    });

    it("gives input mode a composer-width taskbar strip", () => {
      expect(computeBottomBarSurfaceFrame(workArea, "INPUT")).toEqual(
        computeBottomBarFrame(workArea, {
          width: HOVER_BOTTOM_BAR_WIDTH,
          height: HOVER_BOTTOM_BAR_HEIGHT,
        }),
      );
    });

    it("keeps the composer width and bottom anchor while making room above for its menu", () => {
      expect(computeBottomBarSurfaceFrame(workArea, "INPUT_MENU")).toEqual({
        x: 760,
        y: 704,
        width: 600,
        height: 320,
      });
    });

    it("opens centered phone-width sheets at under-half and half-or-over heights", () => {
      expect(computeBottomBarSurfaceFrame(workArea, "OPEN_UNDER_HALF")).toEqual(
        { x: 740, y: 604, width: 640, height: 420 },
      );
      expect(
        computeBottomBarSurfaceFrame(workArea, "OPEN_HALF_OR_OVER"),
      ).toEqual({ x: 740, y: 404, width: 640, height: 620 });
    });

    it("gives MAXIMIZED the complete usable work area", () => {
      expect(computeBottomBarSurfaceFrame(workArea, "MAXIMIZED")).toEqual(
        workArea,
      );
    });
  });

  it("rejects forged native surface states", () => {
    expect(isBottomBarSurfaceState("INPUT_MENU")).toBe(true);
    expect(isBottomBarSurfaceState("MAXIMIZED")).toBe(true);
    expect(isBottomBarSurfaceState("fullscreen")).toBe(false);
    expect(isBottomBarSurfaceState({ state: "CLOSED" })).toBe(false);
  });

  describe("resolveDesktopShellWindowPresentation", () => {
    it("keeps the bottom-bar host transparent on every desktop platform", () => {
      expect(resolveDesktopShellWindowPresentation({}, [], "win32")).toEqual({
        mode: "bottom-bar",
        titleBarStyle: "hidden",
        transparent: true,
        nativeShadow: false,
      });
      expect(resolveDesktopShellWindowPresentation({}, [], "darwin")).toEqual({
        mode: "bottom-bar",
        titleBarStyle: "hidden",
        transparent: true,
        nativeShadow: false,
      });
      expect(resolveDesktopShellWindowPresentation({}, [], "linux")).toEqual({
        mode: "bottom-bar",
        titleBarStyle: "hidden",
        transparent: true,
        nativeShadow: false,
      });
    });

    it("reports the legacy full-window presentation when opted out (=0)", () => {
      expect(
        resolveDesktopShellWindowPresentation(
          { ELIZA_DESKTOP_BOTTOM_BAR: "0" },
          [],
          "win32",
        ),
      ).toEqual({
        mode: "default",
        titleBarStyle: "default",
        transparent: false,
        nativeShadow: true,
      });
      expect(
        resolveDesktopShellWindowPresentation(
          { ELIZA_DESKTOP_BOTTOM_BAR: "0" },
          [],
          "darwin",
        ),
      ).toEqual({
        mode: "default",
        titleBarStyle: "hiddenInset",
        transparent: false,
        nativeShadow: true,
      });
    });

    it("reports kiosk as hidden and opaque", () => {
      expect(
        resolveDesktopShellWindowPresentation(
          {
            ELIZA_DESKTOP_BOTTOM_BAR: "1",
            ELIZAOS_SHELL_MODE: "kiosk",
          },
          [],
          "darwin",
        ),
      ).toEqual({
        mode: "kiosk",
        titleBarStyle: "hidden",
        transparent: false,
        nativeShadow: false,
      });
    });
  });

  describe("shouldReanchorBottomBar", () => {
    const base = { x: 0, y: 24, width: 1920, height: 1056 };

    it("does not re-anchor when the work area is unchanged", () => {
      expect(shouldReanchorBottomBar(base, { ...base })).toBe(false);
    });

    it("re-anchors on a width/height change (dock or resolution change)", () => {
      expect(shouldReanchorBottomBar(base, { ...base, width: 1440 })).toBe(
        true,
      );
      expect(shouldReanchorBottomBar(base, { ...base, height: 900 })).toBe(
        true,
      );
    });

    it("re-anchors on an origin change (display plug/unplug, monitor swap)", () => {
      expect(shouldReanchorBottomBar(base, { ...base, x: 1920 })).toBe(true);
      expect(shouldReanchorBottomBar(base, { ...base, y: 0 })).toBe(true);
    });
  });
});
