/**
 * Authoritative process-local record of the view the shell is currently
 * showing, plus its live addressable-element snapshot. Written by the navigate
 * route (`POST /api/views/:id/navigate`) and the element-report route, read by
 * the prompt-optimization layer (`view-action-affinity.ts` awareness block) and
 * the view-scoped-action gate (`view-scoped-actions.ts`).
 *
 * Extracted from `view-action-affinity.ts` so the scoped-action gate and the
 * affinity/awareness renderer can both read this state without a cycle: this
 * module depends on nothing, both consumers depend on it.
 */

/**
 * One addressable element in the active view, as reported by the shell's
 * agent-surface registry (`POST /api/views/:id/elements`). Mirrors the
 * list-elements snapshot shape so the planner (and the scoped-action element
 * resolver) can act on an element by id without a list-elements round-trip.
 */
export interface ActiveViewElement {
  id: string;
  role: string;
  label: string;
  value?: string;
  focused?: boolean;
}

/** Minimal description of the view the shell is currently showing. */
export interface ActiveViewContext {
  viewId: string;
  viewLabel: string;
  viewType: "gui" | "tui" | "xr";
  viewPath: string | null;
  /**
   * Live snapshot of the view's addressable elements, when the shell has
   * reported one. Absent until a report arrives (and re-cleared on navigation),
   * so the awareness block degrades gracefully to "use list-elements".
   */
  elements?: readonly ActiveViewElement[];
  /**
   * ISO timestamp of the most recent switch INTO this view, and who drove it.
   * Carried from the navigate route so Stage-1 can acknowledge a just-happened
   * switch (#8788). Absent when the view was not freshly switched.
   */
  switchedAt?: string;
  source?: "agent" | "user";
}

let activeView: ActiveViewContext | null = null;

export function setActiveViewContext(view: ActiveViewContext | null): void {
  activeView = view;
}

export function getActiveViewContext(): ActiveViewContext | null {
  return activeView;
}

export function clearActiveViewContext(): void {
  activeView = null;
}

/**
 * Update the element snapshot for the active view. Gated on `viewId` matching
 * the current active view so a stale or background view's report (the shell may
 * have several mounted surfaces) can never overwrite the foreground view's
 * elements. Returns false when no view is active or the id differs.
 */
export function setActiveViewElements(
  viewId: string,
  elements: readonly ActiveViewElement[],
): boolean {
  if (!activeView || activeView.viewId !== viewId) return false;
  activeView = { ...activeView, elements };
  return true;
}
