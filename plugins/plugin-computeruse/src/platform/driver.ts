/**
 * Driver-selection seam for desktop input + screenshot capture.
 *
 * Default = `nutjs` (cross-platform native bindings via @nut-tree-fork/nut-js).
 * Set `ELIZA_COMPUTERUSE_DRIVER=legacy` to fall back to the per-OS shell
 * drivers (cliclick/xdotool/PowerShell). The legacy drivers also activate
 * automatically when the nutjs native module fails to load.
 *
 * Each exported function dispatches to the chosen backend. Callers (the
 * service, actions, tests) use these wrappers; the underlying `desktop.ts`
 * and `screenshot.ts` modules remain importable for the legacy code path.
 */

import { logger } from "@elizaos/core";
import type { ScreenRegion } from "../types.js";
import {
  desktopClick,
  desktopClickWithModifiers,
  desktopDoubleClick,
  desktopDrag,
  desktopKeyCombo,
  desktopKeyPress,
  desktopMouseMove,
  desktopRightClick,
  desktopScroll,
  desktopType,
  legacyGetCursorPosition,
  win32TrySetValueByPattern,
} from "./desktop.js";
import {
  loadFailureReason,
  isAvailable as nutAvailable,
  nutCaptureScreenshot,
  nutClick,
  nutClickWithModifiers,
  nutDoubleClick,
  nutDrag,
  nutDragPath,
  nutGetCursorPosition,
  nutKeyCombo,
  nutKeyDown,
  nutKeyPress,
  nutKeyUp,
  nutMiddleClick,
  nutMouseDown,
  nutMouseMove,
  nutMouseUp,
  nutRightClick,
  nutScroll,
  nutType,
} from "./nut-driver.js";
import { captureScreenshot as legacyCaptureScreenshot } from "./screenshot.js";

export type DriverName = "nutjs" | "legacy";

let warned = false;

export function selectedDriver(): DriverName {
  const requested = (process.env.ELIZA_COMPUTERUSE_DRIVER ?? "nutjs")
    .trim()
    .toLowerCase();
  if (requested === "legacy") return "legacy";
  if (requested !== "nutjs") {
    if (!warned) {
      logger.warn(
        `[computeruse] Unknown ELIZA_COMPUTERUSE_DRIVER=${requested}; falling back to legacy.`,
      );
      warned = true;
    }
    return "legacy";
  }
  if (!nutAvailable()) {
    if (!warned) {
      logger.warn(
        `[computeruse] nutjs driver unavailable (${loadFailureReason()}); falling back to legacy shell drivers.`,
      );
      warned = true;
    }
    return "legacy";
  }
  return "nutjs";
}

// ── Mouse ───────────────────────────────────────────────────────────────────

export async function driverClick(x: number, y: number): Promise<void> {
  if (selectedDriver() === "nutjs") return nutClick(x, y);
  desktopClick(x, y);
}

export async function driverClickWithModifiers(
  x: number,
  y: number,
  modifiers: string[],
): Promise<void> {
  if (selectedDriver() === "nutjs")
    return nutClickWithModifiers(x, y, modifiers);
  desktopClickWithModifiers(x, y, modifiers);
}

export async function driverDoubleClick(x: number, y: number): Promise<void> {
  if (selectedDriver() === "nutjs") return nutDoubleClick(x, y);
  desktopDoubleClick(x, y);
}

export async function driverRightClick(x: number, y: number): Promise<void> {
  if (selectedDriver() === "nutjs") return nutRightClick(x, y);
  desktopRightClick(x, y);
}

/** The legacy shell drivers (cliclick/xdotool/PowerShell) do not expose the
 * granular press/hold primitives below. Throw a clear, actionable error rather
 * than silently no-op'ing — set `ELIZA_COMPUTERUSE_DRIVER=nutjs` to use them. */
function requireNutForGranular(verb: string): never {
  throw new Error(
    `[computeruse] "${verb}" requires the nutjs driver (granular press/hold ` +
      `is not available on the legacy shell drivers). The nutjs native module ` +
      `is unavailable (${loadFailureReason() ?? "unknown reason"}). ` +
      `Set ELIZA_COMPUTERUSE_DRIVER=nutjs once the native binding loads.`,
  );
}

export async function driverMiddleClick(x: number, y: number): Promise<void> {
  if (selectedDriver() === "nutjs") return nutMiddleClick(x, y);
  return requireNutForGranular("middle_click");
}

export async function driverMouseDown(
  x: number,
  y: number,
  button: "left" | "middle" | "right" = "left",
): Promise<void> {
  if (selectedDriver() === "nutjs") return nutMouseDown(x, y, button);
  return requireNutForGranular("mouse_down");
}

export async function driverMouseUp(
  x: number,
  y: number,
  button: "left" | "middle" | "right" = "left",
): Promise<void> {
  if (selectedDriver() === "nutjs") return nutMouseUp(x, y, button);
  return requireNutForGranular("mouse_up");
}

export async function driverMouseMove(x: number, y: number): Promise<void> {
  if (selectedDriver() === "nutjs") return nutMouseMove(x, y);
  desktopMouseMove(x, y);
}

export async function driverGetCursorPosition(): Promise<{
  x: number;
  y: number;
}> {
  // nutjs `mouse.getPosition()` returns a stale/constant value on Windows
  // (empirically verified), so always use the reliable OS query there
  // (System.Windows.Forms.Cursor). Elsewhere prefer nutjs when it is active.
  if (process.platform === "win32") return legacyGetCursorPosition();
  if (selectedDriver() === "nutjs") return nutGetCursorPosition();
  return legacyGetCursorPosition();
}

export async function driverDrag(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  if (selectedDriver() === "nutjs") return nutDrag(x1, y1, x2, y2);
  desktopDrag(x1, y1, x2, y2);
}

export async function driverDragPath(
  path: Array<{ x: number; y: number }>,
): Promise<void> {
  if (selectedDriver() === "nutjs") return nutDragPath(path);
  // Legacy fallback: collapse the polyline to a straight start→end drag.
  if (path.length < 2) {
    throw new Error("[computeruse] drag path requires at least two points");
  }
  const start = path[0];
  const end = path[path.length - 1];
  desktopDrag(start.x, start.y, end.x, end.y);
}

export async function driverScroll(
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount = 3,
): Promise<void> {
  if (selectedDriver() === "nutjs") return nutScroll(x, y, direction, amount);
  desktopScroll(x, y, direction, amount);
}

// ── Keyboard ────────────────────────────────────────────────────────────────

export async function driverType(text: string): Promise<void> {
  if (selectedDriver() === "nutjs") return nutType(text);
  desktopType(text);
}

export async function driverKeyPress(key: string): Promise<void> {
  if (selectedDriver() === "nutjs") return nutKeyPress(key);
  desktopKeyPress(key);
}

/**
 * Set the value of the UI element at (x,y) (#9170 — trycua/cua `set_value`).
 * On Windows, first try UI Automation `ValuePattern.SetValue` (direct, no
 * keystrokes — best for text inputs / combo boxes). Universal fallback (all
 * platforms, incl. elements without ValuePattern): click to focus, select-all,
 * then type the value — composed of the already-verified click/key-combo/type
 * primitives. `value` is validated by the underlying type primitive.
 */
export async function driverSetValue(
  x: number,
  y: number,
  value: string,
): Promise<void> {
  if (process.platform === "win32" && win32TrySetValueByPattern(x, y, value)) {
    return;
  }
  await driverClick(x, y);
  await driverKeyCombo(process.platform === "darwin" ? "cmd+a" : "ctrl+a");
  await driverType(value);
}

export async function driverKeyCombo(combo: string): Promise<void> {
  if (selectedDriver() === "nutjs") return nutKeyCombo(combo);
  desktopKeyCombo(combo);
}

export async function driverKeyDown(key: string): Promise<void> {
  if (selectedDriver() === "nutjs") return nutKeyDown(key);
  return requireNutForGranular("key_down");
}

export async function driverKeyUp(key: string): Promise<void> {
  if (selectedDriver() === "nutjs") return nutKeyUp(key);
  return requireNutForGranular("key_up");
}

// ── Screenshot ──────────────────────────────────────────────────────────────

export async function driverCaptureScreenshot(
  region?: ScreenRegion,
): Promise<Buffer> {
  if (selectedDriver() === "nutjs") {
    try {
      return await nutCaptureScreenshot(region);
    } catch {
      // error-policy:J4 designed two-tier capture — the legacy shell driver
      // performs the same capture, and its failure throws to the caller;
      // nothing is masked.
      return legacyCaptureScreenshot(region);
    }
  }
  return legacyCaptureScreenshot(region);
}
