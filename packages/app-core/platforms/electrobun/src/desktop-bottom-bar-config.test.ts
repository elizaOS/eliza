import { describe, expect, it } from "vitest";
import {
  appendChatOverlayShellModeParam,
  computeBottomBarFrame,
  DEFAULT_BOTTOM_BAR_HEIGHT,
  resolveDesktopShellWindowPresentation,
  shouldStartBottomBar,
} from "./desktop-bottom-bar-config";

describe("desktop bottom-bar config", () => {
  describe("shouldStartBottomBar", () => {
    it("is off by default", () => {
      expect(shouldStartBottomBar({}, [])).toBe(false);
    });

    it("opts in via ELIZA_DESKTOP_BOTTOM_BAR truthy values", () => {
      for (const value of ["1", "true", "yes", "on", " TRUE "]) {
        expect(
          shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: value }, []),
        ).toBe(true);
      }
    });

    it("ignores falsy / unset values", () => {
      for (const value of ["0", "false", "no", "off", ""]) {
        expect(
          shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: value }, []),
        ).toBe(false);
      }
    });

    it("never starts in kiosk shell mode (env or argv)", () => {
      expect(
        shouldStartBottomBar(
          { ELIZA_DESKTOP_BOTTOM_BAR: "1", ELIZAOS_SHELL_MODE: "kiosk" },
          [],
        ),
      ).toBe(false);
      expect(
        shouldStartBottomBar({ ELIZA_DESKTOP_BOTTOM_BAR: "1" }, [
          "--shell-mode=kiosk",
        ]),
      ).toBe(false);
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
    it("reports the default platform titlebar metadata", () => {
      expect(resolveDesktopShellWindowPresentation({}, [], "win32")).toEqual({
        mode: "default",
        titleBarStyle: "default",
        transparent: false,
      });
      expect(resolveDesktopShellWindowPresentation({}, [], "darwin")).toEqual({
        mode: "default",
        titleBarStyle: "hiddenInset",
        transparent: true,
      });
    });

    it("reports hidden titlebar metadata for the bottom-bar shell", () => {
      expect(
        resolveDesktopShellWindowPresentation(
          { ELIZA_DESKTOP_BOTTOM_BAR: "1" },
          [],
          "darwin",
        ),
      ).toEqual({
        mode: "bottom-bar",
        titleBarStyle: "hidden",
        transparent: true,
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
});
