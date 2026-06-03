/**
 * Shell chrome mode.
 *
 * MINIMAL_SHELL is the conversational-OS experiment: the home/chat surface opens
 * to just ambient space with the always-present ContinuousChatOverlay — no
 * in-view chat panels (conversations sidebar / widgets) and no primary header
 * nav. Navigation is conversational: you ask the agent to open a view ("show me
 * the coding view") and it surfaces over the ambient base. Other views still
 * render with the overlay floating over them.
 *
 * Opt into the minimal shell by setting localStorage `eliza:minimal-shell` to
 * "1" (then reload). The default full app chrome keeps mobile navigation and
 * escape controls visible.
 *
 * Read once at module load (so it is a stable value across renders); toggling it
 * takes effect on the next reload.
 */
export const MINIMAL_SHELL: boolean = (() => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("eliza:minimal-shell") === "1";
  } catch {
    return false;
  }
})();
