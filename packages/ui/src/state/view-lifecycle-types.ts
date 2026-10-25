/**
 * Shared view-lifecycle vocabulary (issue #10202). Pure types only, no runtime,
 * so the controller (`view-lifecycle.ts`), the telemetry stream
 * (`view-runtime-telemetry.ts`), the context, and the hooks can all import the
 * phase/policy types without any import cycle.
 */

import type { EvictReason } from "../cache-telemetry";

export type { EvictReason };

/**
 * The lifecycle phase of a single routed view instance.
 *
 *  - `mounted`    : subtree created but not yet the active/visible view.
 *  - `active`     : the visible view (receives input, runs timers/RAF/media).
 *  - `inactive`   : retained (keep-alive) but hidden; a non-keepAlive view never
 *                    sits here — it goes straight to `evicted` (unmount) on hide.
 *  - `paused`     : hidden AND (app-paused | tab-hidden | memory-pressure) — its
 *                    timers/polling/media/native subscriptions are stopped.
 *  - `evicted`    : unmounted and cleaned up (TTL/LRU/pressure or hide for a
 *                    non-keepAlive view).
 *  - `crashed`    : a render threw and the ViewErrorBoundary caught it.
 *  - `recovering` : a crashed view is being remounted fresh after a Retry.
 */
export type ViewLifecyclePhase =
  | "mounted"
  | "active"
  | "inactive"
  | "paused"
  | "evicted"
  | "crashed"
  | "recovering";

/** Per-view retention policy resolved by `resolveViewLifecyclePolicy`. */
export interface ViewLifecyclePolicy {
  /**
   * Retain the view mounted-but-hidden when another view becomes active
   * (instead of unmounting it). OPT-IN — default `false` preserves today's
   * unmount-on-hide behavior and zero blast radius.
   */
  keepAlive: boolean;
  /**
   * Stop the view's timers/polling/media/native subscriptions while it is
   * hidden or the app is backgrounded. Default `true`: even a non-keepAlive
   * view that is briefly hidden before unmount should not keep working.
   */
  pausable: boolean;
  /**
   * Never evict this view, even under TTL/LRU/memory pressure. Reserved for the
   * structural always-on surfaces (chat, background).
   */
  pinned: boolean;
}

export const DEFAULT_VIEW_LIFECYCLE_POLICY: ViewLifecyclePolicy = {
  keepAlive: false,
  pausable: true,
  pinned: false,
};

/** A per-view lifecycle transition the controller notifies subscribers about. */
export interface ViewLifecycleTransition {
  viewId: string;
  phase: ViewLifecyclePhase;
  /** Previous phase, when there was one. */
  previousPhase?: ViewLifecyclePhase;
  /** Why this transition happened (e.g. the evict reason). */
  reason?: EvictReason | "show" | "hide" | "resume" | "crash" | "recover";
  at: number;
}

export type ViewLifecycleListener = (
  transition: ViewLifecycleTransition,
) => void;
