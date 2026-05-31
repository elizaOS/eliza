/**
 * useHomescreen — the editor's brain.
 *
 * Holds the scene history, applies HOMESCREEN instructions arriving over the
 * view-event bus (the agent's edits), exposes the manual edit-mode controls
 * (undo / redo / reset / duplicate / delete), and persists the current scene to
 * localStorage so a reload keeps the user's customization.
 *
 * The heavy lifting is in pure modules: {@link applyHomescreenInstruction}
 * validates + reduces, {@link scene-history} owns undo/redo. This hook is the
 * thin React/persistence shell.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useViewEvent } from "../hooks/useViewEvent";
import {
  applyHomescreenInstruction,
  type HomescreenInstruction,
} from "./scene-apply";
import {
  canRedo,
  canUndo,
  createHistory,
  currentScene as currentOf,
  type SceneHistory,
} from "./scene-history";
import { createDefaultScene, type HomescreenScene } from "./scene-types";
import { validateScene } from "./scene-validate";

/** View-event type the HOMESCREEN action broadcasts. */
export const HOMESCREEN_APPLY_EVENT = "homescreen:apply";

const STORAGE_KEY = "eliza.homescreen.scene";

function loadPersisted(): HomescreenScene {
  if (typeof localStorage === "undefined") return createDefaultScene();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultScene();
    const result = validateScene(JSON.parse(raw));
    return result.ok ? result.scene : createDefaultScene();
  } catch {
    return createDefaultScene();
  }
}

function persist(scene: HomescreenScene): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scene));
  } catch {
    // Quota or privacy mode — persistence is best-effort, not load-bearing.
  }
}

export interface UseHomescreen {
  scene: HomescreenScene;
  editMode: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Last rejection message from a bad instruction, or null. */
  error: string | null;
  setEditMode: (on: boolean) => void;
  toggleEditMode: () => void;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  duplicate: () => void;
  remove: () => void;
  /** Apply an instruction directly (used by tests and local controls). */
  dispatch: (instruction: HomescreenInstruction) => void;
}

export function useHomescreen(): UseHomescreen {
  const [history, setHistory] = useState<SceneHistory>(() =>
    createHistory(loadPersisted()),
  );
  const [editMode, setEditModeState] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const historyRef = useRef(history);
  historyRef.current = history;

  const dispatch = useCallback((instruction: HomescreenInstruction) => {
    const { history: next, error: err } = applyHomescreenInstruction(
      historyRef.current,
      instruction,
    );
    setError(err);
    if (next !== historyRef.current) {
      historyRef.current = next;
      setHistory(next);
      persist(currentOf(next));
    }
  }, []);

  // Agent edits arrive over the view-event bus.
  useViewEvent(HOMESCREEN_APPLY_EVENT, (event) => {
    const payload = event.payload as Partial<HomescreenInstruction>;
    if (typeof payload?.op !== "string") return;
    dispatch({ op: payload.op, sceneJson: payload.sceneJson });
    // Any agent edit pops the editor open so the user sees + can revert it.
    setEditModeState(true);
  });

  const setEditMode = useCallback((on: boolean) => setEditModeState(on), []);
  const toggleEditMode = useCallback(() => setEditModeState((v) => !v), []);

  const scene = useMemo(() => currentOf(history), [history]);

  return {
    scene,
    editMode,
    canUndo: canUndo(history),
    canRedo: canRedo(history),
    error,
    setEditMode,
    toggleEditMode,
    undo: useCallback(() => dispatch({ op: "undo" }), [dispatch]),
    redo: useCallback(() => dispatch({ op: "redo" }), [dispatch]),
    reset: useCallback(() => dispatch({ op: "reset" }), [dispatch]),
    duplicate: useCallback(() => dispatch({ op: "duplicate" }), [dispatch]),
    remove: useCallback(() => dispatch({ op: "delete" }), [dispatch]),
    dispatch,
  };
}
