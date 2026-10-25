/**
 * Live-heap pressure monitor (#10196).
 *
 * The bounded module/view caches size off `isUnderMemoryPressure()`, which folds
 * in live heap via {@link isHeapUnderPressure}. But the caps only take effect
 * when a prune actually runs, and the only memory-driven prune trigger the shell
 * had — the non-standard `memorypressure` window event — is never fired by
 * Chromium. So before this, live heap had no path into eviction at all.
 *
 * This monitor closes that loop: while the document is visible it polls
 * `performance.memory` on a low-frequency interval and, when usage crosses
 * {@link HEAP_PRESSURE_RATIO}, dispatches {@link HEAP_PRESSURE_EVENT}. The
 * `DynamicViewLoader` + `retained-lazy` caches listen for it and force-evict
 * idle entries. It is a no-op on engines without `performance.memory`
 * (Safari/Firefox), which keep relying on TTL/visibility/app-pause.
 *
 * The poll loop is intentionally tiny (one timer, a single property read per
 * tick) and edge-triggered logging is left to the cache telemetry; the dispatch
 * itself is idempotent because the caches' prune is.
 */

import { HEAP_PRESSURE_EVENT, isHeapUnderPressure } from "./bounded-view-lru";

/** How often to sample heap while the tab is visible. */
export const HEAP_PRESSURE_POLL_MS = 10_000;

let heapMonitorTimer: ReturnType<typeof setInterval> | null = null;
let heapMonitorVisibilityHandler: (() => void) | null = null;
let heapMonitorInstalled = false;

/**
 * Read heap once and dispatch {@link HEAP_PRESSURE_EVENT} when under pressure.
 * Exported (and pure aside from the dispatch) so tests can drive a tick without
 * waiting on the interval. Returns whether pressure was signalled.
 */
export function checkHeapPressureOnce(): boolean {
  if (typeof document === "undefined") return false;
  if (!isHeapUnderPressure()) return false;
  document.dispatchEvent(new CustomEvent(HEAP_PRESSURE_EVENT));
  return true;
}

function startPolling(): void {
  if (heapMonitorTimer !== null || typeof window === "undefined") return;
  heapMonitorTimer = setInterval(checkHeapPressureOnce, HEAP_PRESSURE_POLL_MS);
}

function stopPolling(): void {
  if (heapMonitorTimer === null) return;
  clearInterval(heapMonitorTimer);
  heapMonitorTimer = null;
}

/**
 * Install the heap monitor once. Idempotent — both cache lifecycles call it, so
 * there is a single shared poll loop regardless of how many caches are active.
 * Polling pauses while the document is hidden (no point evicting a backgrounded
 * tab off heap — visibility-hidden already prunes it) and resumes on show.
 */
export function installHeapPressureMonitor(): void {
  if (heapMonitorInstalled || typeof window === "undefined") return;
  heapMonitorInstalled = true;
  heapMonitorVisibilityHandler = () => {
    if (document.visibilityState === "hidden") {
      stopPolling();
    } else {
      checkHeapPressureOnce();
      startPolling();
    }
  };
  document.addEventListener("visibilitychange", heapMonitorVisibilityHandler);
  // If we got here, window (and thus document) exists. Check heap immediately on
  // install so a tab that boots already under pressure evicts now, not up to one
  // poll interval later.
  if (document.visibilityState !== "hidden") {
    checkHeapPressureOnce();
    startPolling();
  }
}

export function __resetHeapPressureMonitorForTests(): void {
  stopPolling();
  if (typeof document !== "undefined" && heapMonitorVisibilityHandler) {
    document.removeEventListener(
      "visibilitychange",
      heapMonitorVisibilityHandler,
    );
  }
  heapMonitorVisibilityHandler = null;
  heapMonitorInstalled = false;
}
