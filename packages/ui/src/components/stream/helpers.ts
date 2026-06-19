/**
 * Shared helpers and constants for StreamView.
 */

// ---------------------------------------------------------------------------
// Popout / Window sizes
// ---------------------------------------------------------------------------

/** PIP window dimensions (640x360 → captures at 1280x720 on Retina 2x displays). */
export const PIP_SIZE = { width: 640, height: 360 };
export const FULL_SIZE = { width: 1280, height: 720 };

/** Detect popout mode from URL. */
export const IS_POPOUT = (() => {
  if (typeof window === "undefined" || !window.location) return false;
  const params = new URLSearchParams(
    window.location.search || window.location.hash?.split("?")[1] || "",
  );
  return params.has("popout");
})();
