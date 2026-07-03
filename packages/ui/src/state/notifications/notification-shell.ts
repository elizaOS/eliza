import { useSyncExternalStore } from "react";

/**
 * UI open/drag state for the notification center shell — separate from the
 * notification *data* store. The home pull gesture drives `dragPx` live so the
 * real sheet fades in and tracks the finger as it is pulled down; a release past
 * threshold commits to `open`, a short release retracts. The desktop/tray/
 * deep-link entry points open it directly (no drag). One shared store keeps the
 * single headless NotificationCenter the sole renderer while letting the pull —
 * which lives on the home scroller, a different subtree — drive it.
 */

export interface NotificationShellState {
  /** Fully open (settled) — interactive + focus-trapped. */
  open: boolean;
  /** A pull is in progress (finger down); the sheet tracks it, no transition. */
  dragging: boolean;
  /** Live reveal distance in px while dragging (how far the sheet is pulled). */
  dragPx: number;
}

let state: NotificationShellState = { open: false, dragging: false, dragPx: 0 };
const listeners = new Set<() => void>();

function setState(next: Partial<NotificationShellState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

/** A pull began on the home surface — start tracking the sheet to the finger. */
export function beginNotificationDrag(): void {
  if (state.open) return; // already open — a stray pull-start is a no-op
  setState({ dragging: true, dragPx: 0 });
}

/** Live reveal distance (px) while pulling. Ignored once open. */
export function setNotificationDrag(px: number): void {
  if (state.open || !state.dragging) return;
  setState({ dragPx: Math.max(0, px) });
}

/** Pull released past threshold → settle fully open. */
export function commitNotificationDrag(): void {
  setState({ open: true, dragging: false, dragPx: 0 });
}

/** Pull released short / cancelled → retract (the sheet animates back closed). */
export function cancelNotificationDrag(): void {
  setState({ open: false, dragging: false, dragPx: 0 });
}

/** Open directly (tray / deep-link / desktop button / keyboard) — no drag. */
export function openNotificationCenter(): void {
  setState({ open: true, dragging: false, dragPx: 0 });
}

/** Close the notification center. */
export function closeNotificationCenter(): void {
  setState({ open: false, dragging: false, dragPx: 0 });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): NotificationShellState {
  return state;
}

export function useNotificationShell(): NotificationShellState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only reset. */
export function __resetNotificationShellForTests(): void {
  state = { open: false, dragging: false, dragPx: 0 };
  listeners.clear();
}

/** Test-only snapshot. */
export function __getNotificationShellStateForTests(): NotificationShellState {
  return state;
}
