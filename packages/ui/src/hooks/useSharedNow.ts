/**
 * A single, module-level, visibility-gated "current time" ticker shared by
 * every relative-timestamp leaf in the app (see the binding pattern, spec
 * §C.4 of NOTIFICATIONS-WIDGETS-SYSTEM.md).
 *
 * Why a shared ticker instead of one `useNow` per component:
 *  - `useNow` installs its own `setInterval` per calling component. A home
 *    surface with a notification inbox (up to 100 rows) + clock + calendar card
 *    would otherwise arm dozens-to-hundreds of independent minute timers, all
 *    firing on their own phase. This module arms exactly ONE interval for the
 *    whole app and fans the tick out to every subscriber via
 *    `useSyncExternalStore`.
 *  - It is **visibility-gated**: the interval is cleared while `document.hidden`
 *    and re-armed (with an immediate resync) on show. A backgrounded PWA burns
 *    zero timer wakeups - the exact cost the spec forbids ("tickers pause when
 *    the document is hidden", §A.6).
 *
 * The subscription is lazy: the interval only runs while there is at least one
 * subscriber, and is torn down when the last leaf unmounts. So the always-mounted
 * home pays for the ticker only while a relative-time leaf is actually on screen.
 *
 * Render-path determinism: like `useNow`, the server/first-commit snapshot is
 * `0` (never `Date.now()` during render - the UI determinism convention). The
 * real clock is installed after subscribe, in the store, not in render.
 */

import { useSyncExternalStore } from "react";

/** Default cadence for relative "n minutes ago" surfaces. */
export const MINUTE_MS = 60_000;

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * The current tick value (epoch-ms), or `0` before the ticker has installed the
 * real clock. Read via `getSnapshot` so `useSyncExternalStore` can memoize
 * against it (a stable reference between ticks means no spurious re-render).
 */
let currentNow = 0;

/** The live interval id while the document is visible and we have subscribers. */
let intervalId: ReturnType<typeof setInterval> | null = null;

/** Whether the visibility listener is installed (matches `listeners.size > 0`). */
let visibilityBound = false;

function isHidden(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.visibilityState === "string" &&
    document.hidden === true
  );
}

/** Push the current clock to `currentNow` and notify subscribers if it moved. */
function tick(): void {
  const next = Date.now();
  if (next === currentNow) return;
  currentNow = next;
  for (const listener of listeners) listener();
}

/** Arm the interval iff visible + subscribed + not already armed. */
function armInterval(): void {
  if (intervalId !== null) return;
  if (isHidden()) return;
  if (listeners.size === 0) return;
  intervalId = setInterval(tick, MINUTE_MS);
}

/** Clear the interval (used on hide + on last-unsubscribe). */
function clearIntervalIfArmed(): void {
  if (intervalId === null) return;
  clearInterval(intervalId);
  intervalId = null;
}

/**
 * Visibility handler: on hide, stop burning timers; on show, resync the clock
 * immediately (so a leaf that was hidden for an hour jumps straight to the
 * right string) and re-arm the interval.
 */
function handleVisibility(): void {
  if (isHidden()) {
    clearIntervalIfArmed();
    return;
  }
  tick();
  armInterval();
}

function bindVisibility(): void {
  if (visibilityBound) return;
  if (typeof document === "undefined") return;
  document.addEventListener("visibilitychange", handleVisibility);
  visibilityBound = true;
}

function unbindVisibility(): void {
  if (!visibilityBound) return;
  if (typeof document === "undefined") return;
  document.removeEventListener("visibilitychange", handleVisibility);
  visibilityBound = false;
}

/**
 * `useSyncExternalStore` subscribe: register the listener, install the real
 * clock on the FIRST subscriber, and arm the shared interval. Returns the
 * unsubscribe that tears the interval down when the last leaf unmounts.
 */
function subscribe(listener: Listener): () => void {
  const wasEmpty = listeners.size === 0;
  listeners.add(listener);
  if (wasEmpty) {
    // First subscriber: install the real clock (leave `getSnapshot` returning
    // the epoch until this commit so render stays deterministic), then start
    // ticking. `tick()` bumps `currentNow` off 0 and notifies, so the leaf
    // shows a live time on its first effect flush.
    bindVisibility();
    tick();
    armInterval();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearIntervalIfArmed();
      unbindVisibility();
      // Reset the snapshot so a later remount re-enters the deterministic
      // `0` first-render path rather than flashing a stale timestamp.
      currentNow = 0;
    }
  };
}

function getSnapshot(): number {
  return currentNow;
}

/** SSR/first-commit snapshot: always the deterministic epoch (never Date.now). */
function getServerSnapshot(): number {
  return 0;
}

/**
 * Subscribe to the shared, visibility-gated minute ticker. Returns the current
 * time in epoch-ms, or `0` on the first render (deterministic render path - the
 * real clock is installed in the store after subscribe, never during render).
 *
 * Use this in **leaf** components only (a `<RelativeTime>`, a clock text node),
 * never at a list level - the whole point of the binding pattern is that the
 * tick re-renders the text node, not its parent row/list.
 *
 */
export function useSharedNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Test-only: fully reset the module ticker between cases so one test's mounted
 * leaves can't leak an interval / stale snapshot into the next. Not part of the
 * production surface.
 */
export function __resetSharedNowForTests(): void {
  clearIntervalIfArmed();
  unbindVisibility();
  listeners.clear();
  currentNow = 0;
}
