/**
 * Client-side tutorial service — the single owner of tutorial state. The
 * chat-native tour has no overlay engine: this module holds a small guarded
 * state machine (idle → active → completed/stopped, re-startable from any
 * terminal state) that the always-mounted TutorialConductor observes to seed
 * conversational turns into the live chat transcript.
 *
 * Module-level store shared via globalThis (Symbol.for) so a single instance
 * survives HMR and is reachable from non-React callers (the launcher tile,
 * the action channel) + useSyncExternalStore for React consumers. The store
 * key is the historical "elizaos.ui.tutorial-controller" symbol so state
 * carried across an HMR boundary from an older bundle keeps working; reads
 * normalize legacy `{ active, stepIndex }` shapes into the full state.
 *
 * Progress persists to localStorage ("eliza:tutorial-state") so a completed
 * or stopped tour stays quiet across launches; the legacy one-bit
 * "eliza:tutorial-completed" flag is honored on first load.
 */
import { logger } from "@elizaos/logger";
import * as React from "react";
import { shellLocalStorage } from "../surface-realm-channel";
import { TUTORIAL_STEP_IDS } from "./tutorial-script";

const STATE_KEY = "eliza:tutorial-state";
const LEGACY_COMPLETED_KEY = "eliza:tutorial-completed";

export type TutorialStatus = "idle" | "active" | "completed" | "stopped";

export interface TutorialState {
  status: TutorialStatus;
  stepIndex: number;
  /** Run nonce: when the active run began. Null unless a run started. */
  startedAt: number | null;
  completedStepIds: readonly string[];
  /** Derived from status; kept on the state for legacy consumers. */
  active: boolean;
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
  active: false,
};

function isStatus(value: unknown): value is TutorialStatus {
  return (
    value === "idle" ||
    value === "active" ||
    value === "completed" ||
    value === "stopped"
  );
}

/**
 * Coerce whatever is in the store into a full TutorialState. The globalThis
 * store can hold a legacy `{ active, stepIndex }` shape written by an older
 * bundle across an HMR boundary (or by tests that reset the raw store), so
 * reads repair the shape instead of trusting it.
 */
function normalize(raw: unknown): TutorialState {
  if (typeof raw !== "object" || raw === null) return IDLE_STATE;
  const r = raw as Partial<TutorialState>;
  const status = isStatus(r.status)
    ? r.status
    : r.active === true
      ? "active"
      : "idle";
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
    startedAt: typeof r.startedAt === "number" ? r.startedAt : null,
    completedStepIds: Array.isArray(r.completedStepIds)
      ? r.completedStepIds.filter((id): id is string => typeof id === "string")
      : [],
    active: status === "active",
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
    if (localStorage.getItem(LEGACY_COMPLETED_KEY) === "1") {
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

function store(): TutorialStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  const k = Symbol.for("elizaos.ui.tutorial-controller");
  const existing = g[k] as TutorialStore | undefined;
  if (existing) return existing;
  const created: TutorialStore = {
    state: typeof localStorage === "undefined" ? IDLE_STATE : readPersisted(),
    listeners: new Set(),
  };
  g[k] = created;
  return created;
}

function persist(state: TutorialState): void {
  try {
    shellLocalStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        status: state.status,
        stepIndex: state.stepIndex,
        startedAt: state.startedAt,
        completedStepIds: state.completedStepIds,
      }),
    );
    if (state.status === "completed") {
      shellLocalStorage.setItem(LEGACY_COMPLETED_KEY, "1");
    }
  } catch (err) {
    // error-policy:J4 storage unavailable (private mode) — the tour still runs,
    // it just won't stay quiet across launches.
    logger.debug({ err }, "[TutorialService] persist failed");
  }
}

function set(next: TutorialState): void {
  const s = store();
  s.state = next;
  persist(next);
  for (const l of s.listeners) l();
}

function isWellFormed(state: TutorialState): boolean {
  return (
    isStatus(state.status) &&
    state.active === (state.status === "active") &&
    Number.isInteger(state.stepIndex) &&
    state.stepIndex >= 0 &&
    state.stepIndex < TUTORIAL_STEP_IDS.length &&
    Array.isArray(state.completedStepIds)
  );
}

export function getTutorialState(): TutorialState {
  const s = store();
  // Repair a legacy-shaped state in place ONCE (not per read) so
  // useSyncExternalStore's snapshot identity stays stable between reads.
  if (!isWellFormed(s.state)) s.state = normalize(s.state);
  return s.state;
}

function begin(): void {
  set({
    status: "active",
    stepIndex: 0,
    startedAt: Date.now(),
    completedStepIds: [],
    active: true,
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
  set({ ...current, status: "stopped", active: false });
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
    set({ ...current, status: "completed", active: false, completedStepIds });
    return;
  }
  set({ ...current, stepIndex: current.stepIndex + 1, completedStepIds });
}

export function useTutorial(): TutorialState {
  const s = store();
  return React.useSyncExternalStore(
    (l) => {
      s.listeners.add(l);
      return () => s.listeners.delete(l);
    },
    getTutorialState,
    getTutorialState,
  );
}
