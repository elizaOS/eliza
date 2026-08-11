/**
 * Touch-target sizing helpers for projected homepage hit overlays. Keeps the
 * 44×44 CSS-pixel floor independent of the WebGL model runtime.
 */

export const TOUCH_OVERLAY_MIN_SIZE = 44;

/** Expand a projected hit rect to at least 44×44 CSS pixels without shrinking. */
export function resolveTouchOverlaySize(
  width: number,
  height: number,
  minSize: number = TOUCH_OVERLAY_MIN_SIZE,
): {
  width: number;
  height: number;
} {
  return {
    width: Math.max(width, minSize),
    height: Math.max(height, minSize),
  };
}
