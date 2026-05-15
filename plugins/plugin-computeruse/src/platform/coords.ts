/**
 * Coordinate translation between display-local and OS-global pixel space (WS5).
 *
 * Contract:
 *   - Every public mouse-bearing action accepts `{displayId, x, y}` where
 *     `(x, y)` is LOCAL to that display (top-left = 0,0, units = pixels of the
 *     display's logical bounds).
 *   - This module translates to the OS-global space the input drivers expect.
 *
 * Why local-first:
 *   - The model sees each display independently (one capture, no virtual
 *     desktop stitching). Local coords match what the model just looked at.
 *   - Virtual-desktop coords are a perpetual DPI / negative-origin bug source.
 *
 * Per-OS behavior of the input drivers we wrap (nutjs / xdotool / cliclick /
 * PowerShell `SetCursorPos`):
 *   - Linux/X11: drivers expect global pixel coords matching xrandr origins.
 *     Translation = display.x + local.x. No DPI conversion.
 *   - Windows:   `SetCursorPos` and nutjs both take physical pixel coords
 *     when the process is PerMonitorV2 DPI aware. Translation = display.x +
 *     local.x. No multiplier here — caller is responsible for declaring
 *     dpiAwareness.
 *   - macOS:     Quartz event coords are in points (logical), not backing-
 *     store pixels. Translation = display.x + local.x with no scale multiply
 *     IF the local coords are also in points. We document the local coord
 *     space as "logical pixels" matching the capture's render at logical
 *     resolution; for retina captures the screenshot is upsampled to backing-
 *     store pixels and the model is expected to scale clicks back down
 *     before sending. The translator divides by scaleFactor when local
 *     coords were sourced from a backing-store-resolution screenshot.
 */

import type { DisplayInfo } from "./displays.js";
import { findDisplay, getPrimaryDisplay, listDisplays } from "./displays.js";
import { currentPlatform } from "./helpers.js";

export interface LocalPoint {
  displayId: number;
  x: number;
  y: number;
}

export interface GlobalPoint {
  x: number;
  y: number;
}

/**
 * Resolve a LocalPoint to a GlobalPoint the input driver can act on.
 *
 * `coordSource` describes the coordinate reference:
 *   - `"logical"` (default) — local coords are in logical pixels matching the
 *     display's `bounds[2..3]`. No scale conversion is applied.
 *   - `"backing"` — local coords were taken against a capture rendered at
 *     `bounds * scaleFactor` (e.g. raw retina PNG). They are divided by
 *     scaleFactor before translation. macOS-only relevant.
 */
export function localToGlobal(
  point: LocalPoint,
  coordSource: "logical" | "backing" = "logical",
): GlobalPoint {
  const display = findDisplay(point.displayId);
  if (!display) {
    throw new Error(
      `Unknown displayId ${point.displayId}. Known displays: ${listDisplays()
        .map((d) => `${d.id}(${d.name})`)
        .join(", ")}`,
    );
  }
  return translate(display, point.x, point.y, coordSource);
}

/**
 * As `localToGlobal`, but tolerates a missing displayId by defaulting to the
 * primary display. Logs nothing — callers should warn before using this.
 */
export function localToGlobalDefault(
  point: { displayId?: number; x: number; y: number },
  coordSource: "logical" | "backing" = "logical",
): GlobalPoint {
  if (point.displayId === undefined) {
    const primary = getPrimaryDisplay();
    return translate(primary, point.x, point.y, coordSource);
  }
  return localToGlobal(
    { displayId: point.displayId, x: point.x, y: point.y },
    coordSource,
  );
}

function translate(
  display: DisplayInfo,
  localX: number,
  localY: number,
  coordSource: "logical" | "backing",
): GlobalPoint {
  let lx = localX;
  let ly = localY;
  if (coordSource === "backing" && currentPlatform() === "darwin") {
    const s = display.scaleFactor || 1;
    if (s > 0) {
      lx = localX / s;
      ly = localY / s;
    }
  }
  return {
    x: Math.round(display.bounds[0] + lx),
    y: Math.round(display.bounds[1] + ly),
  };
}

/**
 * Inverse: given an OS-global point, return the (displayId, x, y) of the
 * display containing it. Returns null if no display contains the point.
 * Useful for translating OS-reported cursor positions back to local coords.
 */
export function globalToLocal(point: GlobalPoint): LocalPoint | null {
  for (const d of listDisplays()) {
    const [x, y, w, h] = d.bounds;
    if (point.x >= x && point.x < x + w && point.y >= y && point.y < y + h) {
      return { displayId: d.id, x: point.x - x, y: point.y - y };
    }
  }
  return null;
}

/**
 * Validate a local point is inside its display's bounds. Returns the clamped
 * point — never throws. Use this before sending to drivers that crash on
 * out-of-bounds coords on some Linux versions.
 */
export function clampToDisplay(point: LocalPoint): LocalPoint {
  const display = findDisplay(point.displayId);
  if (!display) return point;
  const [, , w, h] = display.bounds;
  return {
    displayId: point.displayId,
    x: Math.max(0, Math.min(point.x, Math.max(0, w - 1))),
    y: Math.max(0, Math.min(point.y, Math.max(0, h - 1))),
  };
}
