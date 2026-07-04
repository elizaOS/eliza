/**
 * Global tutorial controller. The interactive tour is a persistent OVERLAY (not
 * a tab view) because it navigates the user around the real app — to Settings,
 * back home — and must survive those navigations. The home "Tutorial" tile and
 * the launcher view call `startTutorial()`; the always-mounted `TutorialOverlay`
 * (in App.tsx) subscribes and renders the spotlight + step engine when active.
 *
 * Module-level store (shared via globalThis so a single instance survives HMR
 * and is reachable from the tile handler outside React) + useSyncExternalStore.
 */
import * as React from "react";

const COMPLETED_KEY = "eliza:tutorial-completed";

export interface TutorialState {
  active: boolean;
  stepIndex: number;
}

interface TutorialStore {
  state: TutorialState;
  listeners: Set<() => void>;
}

function store(): TutorialStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  const k = Symbol.for("elizaos.ui.tutorial-controller");
  const existing = g[k] as TutorialStore | undefined;
  if (existing) return existing;
  const created: TutorialStore = {
    state: { active: false, stepIndex: 0 },
    listeners: new Set(),
  };
  g[k] = created;
  return created;
}

function set(next: Partial<TutorialState>): void {
  const s = store();
  s.state = { ...s.state, ...next };
  for (const l of s.listeners) l();
}

export function startTutorial(): void {
  set({ active: true, stepIndex: 0 });
}

/** Stop + mark complete so it never nags again (but stays re-runnable from the tile). */
export function stopTutorial(): void {
  set({ active: false, stepIndex: 0 });
  try {
    localStorage.setItem(COMPLETED_KEY, "1");
  } catch {
    /* storage unavailable — fine */
  }
}

export function goToStep(index: number): void {
  set({ stepIndex: Math.max(0, index) });
}

export function useTutorial(): TutorialState {
  const s = store();
  return React.useSyncExternalStore(
    (l) => {
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    },
    () => s.state,
    () => s.state,
  );
}
