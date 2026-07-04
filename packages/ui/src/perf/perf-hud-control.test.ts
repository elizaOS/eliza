// @vitest-environment jsdom

/**
 * Covers the perf-HUD enable affordance: boot-from-flag/pref, the hotkey and
 * console-handle toggles, and that each path flips `window.__ELIZA_PERF_HUD__`
 * and emits PERF_TOGGLE_EVENT. Drives window globals + localStorage under jsdom.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootPerfHud,
  installPerfHudHotkey,
  isPerfHudFlag,
  PERF_TOGGLE_EVENT,
  setPerfHud,
  togglePerfHud,
} from "./perf-hud-control";

type PerfHudWindow = Window & {
  __ELIZA_PERF_HUD__?: boolean;
  __elizaPerfHud?: (enabled?: boolean) => boolean;
};

function perfWindow(): PerfHudWindow {
  return window as PerfHudWindow;
}

afterEach(() => {
  delete perfWindow().__ELIZA_PERF_HUD__;
  delete perfWindow().__elizaPerfHud;
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("perf HUD control", () => {
  it("sets the HUD flag, persists it, and dispatches the shared toggle event", () => {
    const listener = vi.fn();
    window.addEventListener(PERF_TOGGLE_EVENT, listener);

    setPerfHud(true);

    expect(isPerfHudFlag()).toBe(true);
    expect(window.localStorage.getItem("eliza:perf-hud")).toBe("1");
    expect(listener).toHaveBeenCalledTimes(1);

    window.removeEventListener(PERF_TOGGLE_EVENT, listener);
  });

  it("restores a persisted boot opt-in", () => {
    window.localStorage.setItem("eliza:perf-hud", "1");

    bootPerfHud();

    expect(isPerfHudFlag()).toBe(true);
  });

  it("toggles through the console handle and hotkey", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const cleanup = installPerfHudHotkey();

    expect(perfWindow().__elizaPerfHud?.(true)).toBe(true);
    expect(isPerfHudFlag()).toBe(true);

    const hotkey = new KeyboardEvent("keydown", {
      key: "p",
      ctrlKey: true,
      shiftKey: true,
      cancelable: true,
    });
    window.dispatchEvent(hotkey);

    expect(isPerfHudFlag()).toBe(false);
    expect(hotkey.defaultPrevented).toBe(true);
    expect(info).toHaveBeenCalledWith(
      "[PerfHUD] off - FPS/jank HUD + frame-budget telemetry (reflow + re-render telemetry stay on in dev)",
    );

    cleanup();
    expect(perfWindow().__elizaPerfHud).toBeUndefined();
  });

  it("toggles programmatically", () => {
    expect(togglePerfHud()).toBe(true);
    expect(togglePerfHud()).toBe(false);
  });
});
