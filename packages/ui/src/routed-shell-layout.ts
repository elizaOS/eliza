/**
 * Routed-shell spacing policy.
 *
 * Most legacy tool views rely on the shell's compact page gutter. Views that
 * render their own full canvas, responsive content rail, or split workspace
 * must stay flush so horizontal and top spacing have exactly one owner.
 */

const CANVAS_OWNED_ROUTE_TABS = new Set([
  "apps",
  "background",
  "calendar",
  "documents",
  "inventory",
  "memories",
  "notes",
  "settings",
  "trajectories",
  "views",
]);

/**
 * The routed `<main>` never owns bottom spacing. `AppWorkspaceContent` or a
 * fullscreen view reserves safe-area and floating-composer clearance exactly
 * once at the active scroll/content boundary. Browser is intentionally absent:
 * its fullscreen manifest bypasses the routed shell before this helper runs.
 */
export function routedShellMainClass(tab: string): string {
  const pagePadding = CANVAS_OWNED_ROUTE_TABS.has(tab)
    ? ""
    : "px-2 sm:px-3 pt-[var(--view-pad-top)]";
  return `flex flex-1 min-h-0 min-w-0 overflow-hidden ${pagePadding}`;
}
