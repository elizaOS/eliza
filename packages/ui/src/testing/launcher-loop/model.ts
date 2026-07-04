/**
 * Pure launcher-loop model — the expected state of the home ↔ launcher surface,
 * advanced by the same abstract actions the fast-check command loop drives
 * through a real driver (`commands.ts`). It carries no DOM or async: given a
 * starting state and an action it returns the next state, so a command can
 * predict what the surface MUST look like after it runs and `invariants.ts` can
 * check the real observation against it.
 *
 * The state mirrors the launcher's single source of truth: which rail half is
 * showing (`shell-surface-store`), where keyboard focus belongs, and a monotone
 * count of tile launches (the telemetry `launch`-count invariant, §D item 10).
 * Rejected gestures — a settle-back drag, a launcher-half left flick with
 * nowhere to go — are modeled as no-ops so the model stays the authority on
 * what a "rejected" gesture means. Notifications live in the pinned dashboard
 * widget (NotificationsHomeCenter) — an ordinary scrolling card on the home
 * half, covered by `vertical-widget-scroll`, with no modal open/closed state
 * for the model to track.
 */

export type LauncherPage = "home" | "launcher";

/** Where a keyboard user's focus is allowed to live for a given page. */
export type FocusZone = "home" | "launcher";

export interface LauncherModelState {
  /** Which rail half is showing. Mirrors `shell-surface-store`'s `page`. */
  readonly page: LauncherPage;
  /** The half keyboard focus must stay within (never the inert offscreen half). */
  readonly focusZone: FocusZone;
  /** Monotone count of committed tile launches (telemetry `launch` events). */
  readonly launchCount: number;
}

export const INITIAL_MODEL_STATE: LauncherModelState = {
  page: "home",
  focusZone: "home",
  launchCount: 0,
};

/**
 * The abstract action alphabet — the §D `[L]` set, minus platform detail. A
 * command in `commands.ts` owns exactly one of these; the model interprets it
 * independently of how the driver realizes it (CDP touch, mouse, keyboard).
 *
 * Speed/length live on the gesture actions because the model's accept/reject
 * decision depends on them: a rail flick commits only past the commit threshold
 * (distance OR release velocity), matching `useHorizontalPager`.
 */
export type LauncherAction =
  | {
      readonly kind: "rail-swipe";
      readonly direction: "left" | "right";
      readonly committed: boolean;
    }
  | { readonly kind: "rail-edge-button"; readonly direction: "prev" | "next" }
  | { readonly kind: "tile-tap"; readonly tileId: string }
  | { readonly kind: "tile-long-press"; readonly tileId: string }
  | { readonly kind: "grid-scroll"; readonly dy: number }
  | { readonly kind: "vertical-widget-scroll"; readonly dy: number }
  | { readonly kind: "tab-focus" };

/**
 * The single transition function: `state -(action)-> state`. Pure and total —
 * every action maps to a defined next state, and gestures that the launcher
 * would reject collapse to the identity (a no-op), which is exactly what a
 * "rejected gesture" means to the model.
 *
 * Rail rules (mirror `useHorizontalPager` + `HomeLauncherSurface`):
 * - a left swipe/next commits home→launcher only from home,
 * - a right swipe/prev commits launcher→home only from launcher,
 * - an uncommitted (settle-back) swipe changes nothing,
 * - a rail transition re-homes focus into the now-visible half (the offscreen
 *   half is `inert`).
 */
export function advanceModel(
  state: LauncherModelState,
  action: LauncherAction,
): LauncherModelState {
  switch (action.kind) {
    case "rail-swipe": {
      if (!action.committed) return state;
      const target: LauncherPage =
        action.direction === "left" ? "launcher" : "home";
      return commitPage(state, target);
    }
    case "rail-edge-button": {
      const target: LauncherPage =
        action.direction === "next" ? "launcher" : "home";
      return commitPage(state, target);
    }
    case "tile-tap":
    case "tile-long-press": {
      // A tile only launches from the launcher half; a tap that lands during a
      // committed rail swipe is swallowed by the pager (§D item 10) and never
      // reaches the model. A long-press is the SAME launch: the launcher's edit/
      // jiggle mode was removed (#12179 slop item 11), so a tile is a plain
      // `<Button onClick>` with no long-press handler — a stationary press+release
      // synthesizes a click and launches exactly once, like a tap. "No ghost
      // launch" (§D item 38) holds as long as it launches once, not zero times.
      if (state.page !== "launcher") return state;
      return { ...state, launchCount: state.launchCount + 1 };
    }
    case "grid-scroll":
    case "vertical-widget-scroll":
      // Vertical scroll never flips the rail (axis lock, §D items 6/27/33).
      return state;
    case "tab-focus":
      // Focus is always pulled into the visible half; it can never land in the
      // inert offscreen half.
      return { ...state, focusZone: state.page };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function commitPage(
  state: LauncherModelState,
  target: LauncherPage,
): LauncherModelState {
  if (state.page === target) return state;
  return {
    ...state,
    page: target,
    focusZone: target,
  };
}

/** Whether a next (home→launcher) transition is available from `state`. */
export function canGoNext(state: LauncherModelState): boolean {
  return state.page === "home";
}

/** Whether a prev (launcher→home) transition is available from `state`. */
export function canGoPrev(state: LauncherModelState): boolean {
  return state.page === "launcher";
}
