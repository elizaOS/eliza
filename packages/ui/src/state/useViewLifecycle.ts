/**
 * View-author lifecycle hooks (issue #10202, criterion #2 — "a consistent
 * pause/resume story for timers, polling, media, and native bridge
 * subscriptions").
 *
 * `useViewLifecycle` is the ONE hook a view uses to react to its own
 * mount/show/hide/pause/resume/evict transitions. `usePauseAware` exposes the
 * paused/active booleans for ad-hoc gating (media, native subscriptions).
 * `usePausableInterval` is the batteries-included timer that auto-stops while
 * the view is paused/hidden and restarts on resume — and registers itself with
 * `resource-counters` so a pending-timer leak is observable.
 *
 * Outside a `ViewLifecycleSlot` (e.g. a view not yet migrated onto the
 * keep-alive host) these degrade gracefully: phase is reported as "active" and
 * pausable timers behave like ordinary intervals, so adoption is incremental.
 */

import { useEffect, useRef, useState } from "react";
import { trackTimer } from "../perf/resource-counters";
import { viewLifecycleController } from "./view-lifecycle";
import { useViewLifecycleSlot } from "./view-lifecycle-context";
import type { EvictReason, ViewLifecyclePhase } from "./view-lifecycle-types";

export interface ViewLifecycleHandlers {
  onMount?: () => void;
  onShow?: () => void;
  onHide?: () => void;
  onPause?: (reason: EvictReason) => void;
  onResume?: () => void;
  onEvict?: (reason: EvictReason) => void;
  onRestore?: () => void;
}

export interface ViewLifecycleState {
  phase: ViewLifecyclePhase;
  isActive: boolean;
  isPaused: boolean;
  isHidden: boolean;
}

const ACTIVE_FALLBACK: ViewLifecycleState = {
  phase: "active",
  isActive: true,
  isPaused: false,
  isHidden: false,
};

function deriveState(phase: ViewLifecyclePhase): ViewLifecycleState {
  return {
    phase,
    isActive: phase === "active",
    isPaused: phase === "paused",
    isHidden: phase === "paused" || phase === "inactive",
  };
}

/**
 * Subscribe a view to its own lifecycle. Returns live phase flags and invokes
 * the supplied handlers on transitions so the view can stop/start timers,
 * polling, media, and native bridge subscriptions.
 */
export function useViewLifecycle(
  handlers: ViewLifecycleHandlers = {},
): ViewLifecycleState {
  const slot = useViewLifecycleSlot();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const [phase, setPhase] = useState<ViewLifecyclePhase>(() =>
    slot
      ? (viewLifecycleController.getPhase(slot.viewId) ?? "active")
      : "active",
  );

  useEffect(() => {
    if (!slot) return;
    handlersRef.current.onMount?.();
    // Seed from the controller's current truth (it may have changed between
    // render and effect).
    const current = viewLifecycleController.getPhase(slot.viewId) ?? "active";
    setPhase(current);
    return slot.subscribe((transition) => {
      setPhase(transition.phase);
      const h = handlersRef.current;
      switch (transition.phase) {
        case "active":
          if (transition.reason === "resume") h.onResume?.();
          else h.onShow?.();
          break;
        case "inactive":
          if (transition.reason === "resume") h.onResume?.();
          else h.onHide?.();
          break;
        case "paused":
          h.onHide?.();
          h.onPause?.((transition.reason as EvictReason) ?? "app-pause");
          break;
        case "evicted":
          h.onEvict?.((transition.reason as EvictReason) ?? "lru");
          break;
        case "recovering":
          h.onRestore?.();
          break;
        default:
          break;
      }
    });
  }, [slot]);

  return slot ? deriveState(phase) : ACTIVE_FALLBACK;
}

/** Lightweight paused/active flags for ad-hoc gating (media, native subs). */
export function usePauseAware(): { paused: boolean; active: boolean } {
  const { isPaused, isActive } = useViewLifecycle();
  return { paused: isPaused, active: isActive };
}

/**
 * An interval that auto-stops while the view is paused/hidden and restarts on
 * resume, and registers a pending-timer with `resource-counters` for the active
 * lifetime so a leaked timer is visible in per-view telemetry. Drop-in for
 * `setInterval` in a view body.
 */
export function usePausableInterval(
  callback: () => void,
  delayMs: number,
): void {
  const slot = useViewLifecycleSlot();
  const { isPaused } = useViewLifecycle();
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    // While paused (or delay is non-positive) the timer is fully stopped — no
    // wasted work and no pending-timer counted against the view.
    if (isPaused || delayMs <= 0) return;
    const viewId = slot?.viewId ?? "unscoped";
    const untrack = trackTimer(viewId);
    const id = setInterval(() => callbackRef.current(), delayMs);
    return () => {
      clearInterval(id);
      untrack();
    };
  }, [isPaused, delayMs, slot]);
}
