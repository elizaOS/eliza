import * as React from "react";
import { logger } from "../logger.ts";
import { shellLocalStorage } from "../surface-realm-channel";
import { TUTORIAL_STEP_IDS } from "./tutorial-script";

const STATE_KEY = "eliza:tutorial-state";

export type TutorialStatus = "idle" | "active" | "completed" | "stopped";

export interface TutorialState {
  status: TutorialStatus;
  stepIndex: number;
  /** Run nonce: when the active run began. Null unless a run started. */
  startedAt: number | null;
  completedStepIds: readonly string[];
}

interface TutorialStore {
  state: TutorialState;
  listeners: Set<() => void>;
}

const IDLE_STATE: TutorialState = {
  status: "idle",
  stepIndex: 0,
  startedAt: null,
  completedStepIds: [],
};

function isStatus(value: unknown): value is TutorialStatus {
  return (
    value === "idle" ||
    value === "active" ||
    value === "completed" ||
    value === "stopped"
  );
}

function normalize(raw: unknown): TutorialState {
  if (typeof raw !== "object" || raw === null) return IDLE_STATE;
  const r = raw as Partial<TutorialState>;
  const status = isStatus(r.status) ? r.status : "idle";
  const stepIndex =
    typeof r.stepIndex === "number" &&
    Number.isInteger(r.stepIndex) &&
    r.stepIndex >= 0 &&
    r.stepIndex < TUTORIAL_STEP_IDS.length
      ? r.stepIndex
      : 0;
  return {
    status,
    stepIndex,
    startedAt:
      typeof r.startedAt === "number" && Number.isFinite(r.startedAt)
        ? r.startedAt
        : null,
    completedStepIds: Array.isArray(r.completedStepIds)
      ? r.completedStepIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

function readPersisted(): TutorialState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const state = normalize(parsed);
      // A run that was active at the last unload resumes where it left off —
      // the conductor re-seeds the current step turn on mount.
      return state;
    }
    // Older installs recorded only this flag. Keep their completed tour quiet;
    // a current persisted restart takes precedence and legacy bytes stay intact.
    if (localStorage.getItem("eliza:tutorial-completed") === "1") {
      return { ...IDLE_STATE, status: "completed" };
    }
  } catch (err) {
    // error-policy:J4 storage unavailable (private mode / SSR) or corrupt JSON
    // — the tutorial degrades to fresh in-memory state instead of crashing app
    // boot; nothing downstream depends on persistence existing.
    logger.debug({ err }, "[TutorialService] persisted state unreadable");
  }
  return IDLE_STATE;
}

const store: TutorialStore = {
  state: typeof localStorage === "undefined" ? IDLE_STATE : readPersisted(),
  listeners: new Set(),
};

function persist(state: TutorialState): void {
  try {
    shellLocalStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (err) {
    // error-policy:J4 storage unavailable (private mode) — the tour still runs,
    // it just won't stay quiet across launches.
    logger.debug({ err }, "[TutorialService] persist failed");
  }
}

function set(next: TutorialState): void {
  const s = store;
  s.state = next;
  persist(next);
  for (const l of s.listeners) l();
}

export function getTutorialState(): TutorialState {
  return store.state;
}

function begin(): void {
  set({
    status: "active",
    stepIndex: 0,
    startedAt: Date.now(),
    completedStepIds: [],
  });
}

/**
 * Start the tour. Idle starts fresh; completed/stopped restart from the top
 * (the launcher tile and "start tutorial" both mean "show me the tour", not
 * "resume some prior run"); an already-active tour is a no-op so a double-tap
 * or duplicate command can't yank the user back to the welcome turn.
 */
export function startTutorial(): void {
  if (getTutorialState().status === "active") return;
  begin();
}

/** Stop the active tour. No-op from any non-active state. */
export function stopTutorial(): void {
  const current = getTutorialState();
  if (current.status !== "active") return;
  set({ ...current, status: "stopped" });
}

/** Restart from the top, from any state — resets all progress. */
export function restartTutorial(): void {
  begin();
}

/**
 * Advance past the current step. `fromStepId` guards against stale "Next"
 * taps: earlier steps' choice widgets stay live in the transcript after an
 * auto-advance, and a late tap on one must not skip the step the user is
 * actually on. Advancing past the last step completes the tour.
 */
export function advanceTutorial(fromStepId?: string): void {
  const current = getTutorialState();
  if (current.status !== "active") return;
  const currentStepId = TUTORIAL_STEP_IDS[current.stepIndex];
  if (fromStepId !== undefined && fromStepId !== currentStepId) return;
  const completedStepIds = current.completedStepIds.includes(currentStepId)
    ? current.completedStepIds
    : [...current.completedStepIds, currentStepId];
  if (current.stepIndex >= TUTORIAL_STEP_IDS.length - 1) {
    set({ ...current, status: "completed", completedStepIds });
    return;
  }
  set({ ...current, stepIndex: current.stepIndex + 1, completedStepIds });
}

export function useTutorial(): TutorialState {
  const s = store;
  return React.useSyncExternalStore(
    (l) => {
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    },
    getTutorialState,
    getTutorialState,
  );
}
