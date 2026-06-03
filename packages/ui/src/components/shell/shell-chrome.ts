/**
 * Shell chrome mode.
 *
 * MINIMAL_SHELL is the conversational-OS direction: the home/chat surface opens
 * to just ambient space with the always-present ContinuousChatOverlay — no
 * in-view chat panels (conversations sidebar / widgets) and no primary header
 * nav. Navigation is conversational: you ask the agent to open a view ("show me
 * the coding view") and it surfaces over the ambient base. Other views still
 * render with the overlay floating over them.
 *
 * Flip to the full app chrome (3-panel chat workspace + header nav) by setting
 * localStorage `eliza:minimal-shell` to "0" (then reload). The full-chrome state
 * is also preserved at git tag `her-overlay-full-app-2026-06-02`.
 *
 * Read once at module load (so it is a stable value across renders); toggling it
 * takes effect on the next reload.
 */
export const MINIMAL_SHELL: boolean = (() => {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem("eliza:minimal-shell") !== "0";
  } catch {
    return true;
  }
})();
