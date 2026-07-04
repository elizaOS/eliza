import { describe, expect, it } from "vitest";
import {
  appendChatOverlayShellModeParam,
  computeBottomBarFrame,
  DEFAULT_BOTTOM_BAR_HEIGHT,
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
  });

  describe("computeBottomBarFrame", () => {
    it("pins a full-width bar to the bottom of the work area", () => {
      const frame = computeBottomBarFrame({
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
      });
      expect(frame.width).toBe(1920);
      expect(frame.height).toBe(DEFAULT_BOTTOM_BAR_HEIGHT);
      expect(frame.x).toBe(0);
      expect(frame.y).toBe(1080 - DEFAULT_BOTTOM_BAR_HEIGHT);
    });

    it("respects work-area origin (multi-monitor offset)", () => {
      const frame = computeBottomBarFrame({
        x: 1920,
        y: 24,
        width: 1440,
        height: 900,
      });
      expect(frame.x).toBe(1920);
      expect(frame.width).toBe(1440);
      expect(frame.y).toBe(24 + 900 - DEFAULT_BOTTOM_BAR_HEIGHT);
    });

    it("applies an optional side margin and custom height", () => {
      const frame = computeBottomBarFrame(
        { x: 0, y: 0, width: 1000, height: 800 },
        { height: 100, margin: 20 },
      );
      expect(frame.x).toBe(20);
      expect(frame.width).toBe(960);
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
  });

  describe("resolveDesktopShellWindowPresentation", () => {
    it("reports the bottom-bar presentation by default (#10350)", () => {
      expect(resolveDesktopShellWindowPresentation({}, [], "win32")).toEqual({
        mode: "bottom-bar",
        titleBarStyle: "hidden",
        transparent: false,
      });
      expect(resolveDesktopShellWindowPresentation({}, [], "darwin")).toEqual({
        mode: "bottom-bar",
        titleBarStyle: "hidden",
        transparent: true,
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
