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
} from "./desktop.js";
import {
  isAvailable as nutAvailable,
  loadFailureReason,
  nutCaptureScreenshot,
  nutClick,
  nutClickWithModifiers,
  nutDoubleClick,
  nutDrag,
  nutKeyCombo,
  nutKeyPress,
  nutMouseMove,
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
      // eslint-disable-next-line no-console
      console.warn(
        `[computeruse] Unknown ELIZA_COMPUTERUSE_DRIVER=${requested}; falling back to legacy.`,
      );
      warned = true;
    }
    return "legacy";
  }
  if (!nutAvailable()) {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(
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
  if (selectedDriver() === "nutjs") return nutClickWithModifiers(x, y, modifiers);
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

export async function driverMouseMove(x: number, y: number): Promise<void> {
  if (selectedDriver() === "nutjs") return nutMouseMove(x, y);
  desktopMouseMove(x, y);
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

export async function driverKeyCombo(combo: string): Promise<void> {
  if (selectedDriver() === "nutjs") return nutKeyCombo(combo);
  desktopKeyCombo(combo);
}

// ── Screenshot ──────────────────────────────────────────────────────────────

export async function driverCaptureScreenshot(
  region?: ScreenRegion,
): Promise<Buffer> {
  if (selectedDriver() === "nutjs") {
    try {
      return await nutCaptureScreenshot(region);
    } catch {
      return legacyCaptureScreenshot(region);
    }
  }
  return legacyCaptureScreenshot(region);
}
