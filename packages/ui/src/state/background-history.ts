/**
 * background-history — the pure, browser-safe reducer for the app background's
 * versioned undo/redo (#10694).
 *
 * This is the SINGLE source of the set/undo/redo push-pop semantics, shared by
 * `useDisplayPreferences` (the real store) and the `background-fixture` e2e
 * harness — so the e2e can no longer drift from production by hand-mirroring the
 * logic. It is deliberately free of `persistence` (localStorage + its Node-side
 * import graph) so esbuild can bundle it into the browser e2e fixture; only the
 * pure `BackgroundConfig` type + structural-equality helper are imported.
 */

import {
  type BackgroundConfig,
  backgroundConfigsEqual,
} from "./ui-preferences";

/** Bounded undo/redo depth — capped so a long session never grows unbounded. */
export const MAX_BACKGROUND_HISTORY = 10;

export interface BackgroundHistoryState {
  config: BackgroundConfig;
  /** Previous configs, most-recent last (the undo stack). */
  history: BackgroundConfig[];
  /** Undone configs, most-recent last (the redo stack). */
  redo: BackgroundConfig[];
}

/**
 * Apply a new config: push the outgoing config onto the undo stack and clear the
 * redo future (a fresh edit invalidates redo). A no-op (identical config) leaves
 * state untouched so history never churns.
 */
export function applyBackgroundSet(
  state: BackgroundHistoryState,
  next: BackgroundConfig,
): BackgroundHistoryState {
  if (backgroundConfigsEqual(state.config, next)) return state;
  return {
    config: next,
    history: [...state.history, state.config].slice(-MAX_BACKGROUND_HISTORY),
    redo: state.redo.length ? [] : state.redo,
  };
}

/** Undo: restore the most recent previous config, pop it, push the now-undone
 * current config onto the redo stack. No-op with an empty history. */
export function applyBackgroundUndo(
  state: BackgroundHistoryState,
): BackgroundHistoryState {
  if (state.history.length === 0) return state;
  return {
    config: state.history[state.history.length - 1],
    history: state.history.slice(0, -1),
    redo: [...state.redo, state.config].slice(-MAX_BACKGROUND_HISTORY),
  };
}

/** Redo: re-apply the most recently undone config, push the current one back
 * onto the undo stack. No-op with an empty redo stack. */
export function applyBackgroundRedo(
  state: BackgroundHistoryState,
): BackgroundHistoryState {
  if (state.redo.length === 0) return state;
  return {
    config: state.redo[state.redo.length - 1],
    history: [...state.history, state.config].slice(-MAX_BACKGROUND_HISTORY),
    redo: state.redo.slice(0, -1),
  };
}
