/**
 * Undo/redo history for the homescreen editor — a pure reducer over an immutable
 * list of {@link HomescreenScene} snapshots plus a cursor.
 *
 * The editor needs the customize actions from the goal: edit, save, undo, redo,
 * duplicate, delete, reset-to-default. All of them are expressed here as pure
 * transitions so the live editor (and the HOMESCREEN action's effects) can be
 * unit-tested without a renderer. The React host holds one {@link SceneHistory}
 * in state and dispatches these.
 *
 * Invariants:
 *   - `entries` is never empty (there is always a current scene).
 *   - `cursor` is always a valid index into `entries`.
 *   - A `commit` past the cursor truncates the redo tail (standard linear undo).
 */

import { createDefaultScene, type HomescreenScene } from "./scene-types";

export interface SceneHistory {
  entries: HomescreenScene[];
  cursor: number;
  /** Soft cap so an editing session can't grow history without bound. */
  limit: number;
}

const DEFAULT_LIMIT = 50;

/** The scene at the cursor — the one the editor renders. */
export function currentScene(history: SceneHistory): HomescreenScene {
  return history.entries[history.cursor]!;
}

export function canUndo(history: SceneHistory): boolean {
  return history.cursor > 0;
}

export function canRedo(history: SceneHistory): boolean {
  return history.cursor < history.entries.length - 1;
}

/** Start a history seeded with one scene (defaults to the factory scene). */
export function createHistory(
  initial: HomescreenScene = createDefaultScene(),
  limit: number = DEFAULT_LIMIT,
): SceneHistory {
  return { entries: [initial], cursor: 0, limit: Math.max(1, limit) };
}

/**
 * Commit a new scene as the next history step. Truncates any redo tail, appends,
 * advances the cursor, and trims the oldest entries past `limit`. A commit equal
 * to the current scene is a no-op (avoids polluting history with idempotent
 * saves).
 */
export function commit(
  history: SceneHistory,
  next: HomescreenScene,
): SceneHistory {
  if (next === currentScene(history)) return history;
  const kept = history.entries.slice(0, history.cursor + 1);
  kept.push(next);
  // Trim from the front when over the limit, keeping the cursor on `next`.
  const overflow = Math.max(0, kept.length - history.limit);
  const entries = overflow > 0 ? kept.slice(overflow) : kept;
  return { ...history, entries, cursor: entries.length - 1 };
}

export function undo(history: SceneHistory): SceneHistory {
  if (!canUndo(history)) return history;
  return { ...history, cursor: history.cursor - 1 };
}

export function redo(history: SceneHistory): SceneHistory {
  if (!canRedo(history)) return history;
  return { ...history, cursor: history.cursor + 1 };
}

/**
 * Duplicate the current scene as a fresh, independent document (new id, "(copy)"
 * suffix, refreshed timestamp) committed as the next step.
 */
export function duplicate(history: SceneHistory): SceneHistory {
  const src = currentScene(history);
  const copy: HomescreenScene = {
    ...src,
    id: `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: `${src.name} (copy)`.slice(0, 60),
    updatedAt: Date.now(),
  };
  return commit(history, copy);
}

/**
 * Reset to the factory default scene as a new history step, so the reset itself
 * is undoable (the goal: "reset … in case they break everything").
 */
export function resetToDefault(history: SceneHistory): SceneHistory {
  return commit(history, createDefaultScene());
}

/**
 * Remove the current scene. History always keeps at least one entry, so deleting
 * the last remaining scene resets it to the default instead of emptying.
 */
export function remove(history: SceneHistory): SceneHistory {
  if (history.entries.length <= 1) {
    return { ...history, entries: [createDefaultScene()], cursor: 0 };
  }
  const entries = history.entries.filter((_, i) => i !== history.cursor);
  const cursor = Math.min(history.cursor, entries.length - 1);
  return { ...history, entries, cursor };
}
