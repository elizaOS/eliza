/** Verifies startTutorial through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Unit coverage for the tutorial state machine: every guarded transition
 * (start/stop/restart/advance from each status), localStorage persistence,
 * legacy-flag migration, and repair of legacy-shaped globalThis state.
 * Deterministic — real localStorage (jsdom), no React.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { TUTORIAL_STEP_IDS } from "./tutorial-script";
import {
  advanceTutorial,
  getTutorialState,
  restartTutorial,
  startTutorial,
  stopTutorial,
} from "./tutorial-service";

const STORE_KEY = Symbol.for("elizaos.ui.tutorial-controller");
const STATE_KEY = "eliza:tutorial-state";
const LEGACY_COMPLETED_KEY = "eliza:tutorial-completed";

function resetStore(): void {
  delete (globalThis as Record<PropertyKey, unknown>)[STORE_KEY];
  localStorage.clear();
}

beforeEach(resetStore);

describe("startTutorial", () => {
  it("starts fresh from idle", () => {
    startTutorial();
    const state = getTutorialState();
    expect(state.status).toBe("active");
    expect(state.active).toBe(true);
    expect(state.stepIndex).toBe(0);
    expect(state.startedAt).toBeGreaterThan(0);
    expect(state.completedStepIds).toEqual([]);
  });

  it("is a no-op while a tour is already active (no progress reset)", () => {
    startTutorial();
    advanceTutorial();
    const before = getTutorialState();
    startTutorial();
    expect(getTutorialState()).toBe(before);
  });

  it("restarts from the top after a completed run", () => {
    startTutorial();
    for (let i = 0; i < TUTORIAL_STEP_IDS.length; i += 1) advanceTutorial();
    expect(getTutorialState().status).toBe("completed");
    startTutorial();
    const state = getTutorialState();
    expect(state.status).toBe("active");
    expect(state.stepIndex).toBe(0);
    expect(state.completedStepIds).toEqual([]);
  });

  it("restarts from the top after a stopped run", () => {
    startTutorial();
    advanceTutorial();
    stopTutorial();
    startTutorial();
    const state = getTutorialState();
    expect(state.status).toBe("active");
    expect(state.stepIndex).toBe(0);
  });
});

describe("stopTutorial", () => {
  it("stops an active tour, keeping progress for inspection", () => {
    startTutorial();
    advanceTutorial();
    stopTutorial();
    const state = getTutorialState();
    expect(state.status).toBe("stopped");
    expect(state.active).toBe(false);
    expect(state.stepIndex).toBe(1);
    expect(state.completedStepIds).toEqual([TUTORIAL_STEP_IDS[0]]);
  });

  it("is a no-op from idle, completed, and stopped", () => {
    stopTutorial();
    expect(getTutorialState().status).toBe("idle");

    startTutorial();
    for (let i = 0; i < TUTORIAL_STEP_IDS.length; i += 1) advanceTutorial();
    stopTutorial();
    expect(getTutorialState().status).toBe("completed");

    restartTutorial();
    stopTutorial();
    stopTutorial();
    expect(getTutorialState().status).toBe("stopped");
  });
});

describe("restartTutorial", () => {
  it("resets progress from any state", () => {
    startTutorial();
    advanceTutorial();
    advanceTutorial();
    const firstRun = getTutorialState().startedAt;
    restartTutorial();
    const state = getTutorialState();
    expect(state.status).toBe("active");
    expect(state.stepIndex).toBe(0);
    expect(state.completedStepIds).toEqual([]);
    expect(state.startedAt).not.toBeNull();
    expect(firstRun).not.toBeNull();
  });
});

describe("advanceTutorial", () => {
  it("walks every step and completes past the last", () => {
    startTutorial();
    for (const [index, id] of TUTORIAL_STEP_IDS.entries()) {
      expect(getTutorialState().stepIndex).toBe(index);
      advanceTutorial(id);
    }
    const state = getTutorialState();
    expect(state.status).toBe("completed");
    expect(state.active).toBe(false);
    expect(state.completedStepIds).toEqual([...TUTORIAL_STEP_IDS]);
  });

  it("ignores stale step ids (a late tap on an auto-advanced step's widget)", () => {
    startTutorial();
    advanceTutorial(TUTORIAL_STEP_IDS[0]);
    // The welcome widget is still in the transcript; a second tap must not
    // skip the step the user is actually on.
    advanceTutorial(TUTORIAL_STEP_IDS[0]);
    expect(getTutorialState().stepIndex).toBe(1);
  });

  it("does not record a completed step twice", () => {
    startTutorial();
    advanceTutorial(TUTORIAL_STEP_IDS[0]);
    restartTutorial();
    advanceTutorial(TUTORIAL_STEP_IDS[0]);
    expect(getTutorialState().completedStepIds).toEqual([TUTORIAL_STEP_IDS[0]]);
  });

  it("is a no-op outside an active tour", () => {
    advanceTutorial();
    expect(getTutorialState().status).toBe("idle");
    startTutorial();
    stopTutorial();
    advanceTutorial();
    expect(getTutorialState().stepIndex).toBe(0);
  });
});

describe("persistence", () => {
  it("persists transitions and rehydrates them in a fresh store", () => {
    startTutorial();
    advanceTutorial();
    // Simulate a reload: drop the in-memory store, keep localStorage.
    delete (globalThis as Record<PropertyKey, unknown>)[STORE_KEY];
    const state = getTutorialState();
    expect(state.status).toBe("active");
    expect(state.stepIndex).toBe(1);
    expect(state.completedStepIds).toEqual([TUTORIAL_STEP_IDS[0]]);
  });

  it("honors the legacy one-bit completed flag", () => {
    localStorage.setItem(LEGACY_COMPLETED_KEY, "1");
    expect(getTutorialState().status).toBe("completed");
  });

  it("prefers the structured state over the legacy flag", () => {
    localStorage.setItem(LEGACY_COMPLETED_KEY, "1");
    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({
        status: "stopped",
        stepIndex: 2,
        startedAt: 123,
        completedStepIds: ["welcome"],
      }),
    );
    const state = getTutorialState();
    expect(state.status).toBe("stopped");
    expect(state.stepIndex).toBe(2);
  });

  it("writes the legacy flag on completion so old readers stay satisfied", () => {
    startTutorial();
    for (let i = 0; i < TUTORIAL_STEP_IDS.length; i += 1) advanceTutorial();
    expect(localStorage.getItem(LEGACY_COMPLETED_KEY)).toBe("1");
  });

  it("degrades corrupt persisted JSON to idle", () => {
    localStorage.setItem(STATE_KEY, "{not json");
    expect(getTutorialState().status).toBe("idle");
  });

  it("clamps an out-of-range persisted step index", () => {
    localStorage.setItem(
      STATE_KEY,
      JSON.stringify({ status: "active", stepIndex: 99 }),
    );
    expect(getTutorialState().stepIndex).toBe(0);
  });
});

describe("legacy store-shape repair", () => {
  it("normalizes a legacy { active, stepIndex } store state on read", () => {
    // Tests and pre-move bundles write the old two-field shape straight into
    // the shared globalThis store; reads must repair it, not crash on it.
    startTutorial();
    const store = (globalThis as Record<PropertyKey, unknown>)[STORE_KEY] as {
      state: unknown;
    };
    store.state = { active: true, stepIndex: 1 };
    const state = getTutorialState();
    expect(state.status).toBe("active");
    expect(state.active).toBe(true);
    expect(state.stepIndex).toBe(1);
    expect(state.completedStepIds).toEqual([]);
  });
});
