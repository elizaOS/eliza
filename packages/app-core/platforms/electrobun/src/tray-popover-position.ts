/**
 * Pure geometry for anchoring the tray popover under the system-tray icon
 * (#12184 / #9953 Phase 4).
 *
 * macOS `Tray.getBounds()` returns the `NSStatusItem` button frame in screen
 * coordinates, which are **bottom-left origin** (Cocoa). Electrobun window
 * frames are **top-left origin**. This module owns the origin flip + the
 * x-centering + the work-area clamping so the anchoring is unit-testable
 * without a live tray. Windows/Linux return a zero-rect stub from
 * `getTrayBounds` (fork gaps G3), so a zero-rect falls back to the top-right of
 * the work area (the pre-#12184 behavior).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrayPopoverSize {
  /** Popover width in points. */
  w: number;
  /** Popover height in points. */
  h: number;
  /** Gap between the tray icon / work-area edges and the popover. */
  margin: number;
}

function isZeroRect(rect: Rect): boolean {
  return (
    rect.x === 0 && rect.y === 0 && rect.width === 0 && rect.height === 0
  );
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute the top-left-origin frame for the tray popover.
 *
 * - When `trayBounds` is a real rect: x is centered under the tray icon; y is
 *   the tray icon's bottom edge converted from bottom-left → top-left origin
 *   via `primaryDisplayHeight` (so it hangs just below the menu-bar icon).
 * - When `trayBounds` is a zero-rect (Windows/Linux stub): fall back to the
 *   top-right corner of the work area.
 *
 * The result is always clamped inside `workArea` (inset by `margin`) so the
 * popover can never spill off-screen — including when the icon sits near a
 * screen edge.
 */
export function computeTrayPopoverFrame(
  trayBounds: Rect,
  workArea: Rect,
  size: TrayPopoverSize,
  primaryDisplayHeight: number,
): Rect {
  const { w, h, margin } = size;

  const minX = workArea.x + margin;
  const maxX = workArea.x + workArea.width - w - margin;
  const minY = workArea.y + margin;
  const maxY = workArea.y + workArea.height - h - margin;

  if (isZeroRect(trayBounds)) {
    // No icon geometry (Windows/Linux): pin to the top-right of the work area.
    return {
      x: clamp(workArea.x + workArea.width - w - margin, minX, maxX),
      y: clamp(minY, minY, maxY),
      width: w,
      height: h,
    };
  }

  // Center the popover horizontally under the tray icon.
  const centeredX = trayBounds.x + trayBounds.width / 2 - w / 2;

  // Bottom-left → top-left origin: the icon's bottom edge (visually just under
  // the menu bar) sits at `primaryDisplayHeight - trayBounds.y` in top-left
  // coordinates. Hang the popover from there, then let the clamp pin it below
  // the menu bar (which `workArea.y` already excludes).
  const iconBottomTopLeft = primaryDisplayHeight - trayBounds.y;
  const anchoredY = iconBottomTopLeft + margin;

  return {
    x: Math.round(clamp(centeredX, minX, maxX)),
    y: Math.round(clamp(anchoredY, minY, maxY)),
    width: w,
    height: h,
  };
}
