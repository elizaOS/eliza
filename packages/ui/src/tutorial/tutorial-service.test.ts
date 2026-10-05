// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import "./tutorial-service";
import { TUTORIAL_STEP_IDS } from "./tutorial-script";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("guards duplicate starts and stale advancement, completes, and restarts", async () => {
  const tour = await import("./tutorial-service");
  expect(tour.getTutorialState().status).toBe("idle");
  tour.startTutorial();
  const started = tour.getTutorialState();
  tour.startTutorial();
  expect(tour.getTutorialState()).toBe(started);
  tour.advanceTutorial("not-the-current-step");
  expect(tour.getTutorialState()).toBe(started);
  for (const step of TUTORIAL_STEP_IDS) tour.advanceTutorial(step);
  expect(tour.getTutorialState()).toMatchObject({
    status: "completed",
    completedStepIds: TUTORIAL_STEP_IDS,
  });
  const raw = localStorage.getItem("eliza:tutorial-state");
  if (!raw) throw new Error("Tutorial state was not persisted");
  const persisted = JSON.parse(raw);
  expect(persisted).toEqual(tour.getTutorialState());
  tour.restartTutorial();
  expect(tour.getTutorialState()).toMatchObject({
    status: "active",
    stepIndex: 0,
    completedStepIds: [],
  });
  tour.stopTutorial();
  expect(tour.getTutorialState().status).toBe("stopped");
  const stopped = tour.getTutorialState();
  tour.advanceTutorial();
  expect(tour.getTutorialState()).toBe(stopped);
});

it("restores current progress with a stable snapshot", async () => {
  const persisted = {
    status: "active",
    stepIndex: 1,
    startedAt: 123,
    completedStepIds: [TUTORIAL_STEP_IDS[0]],
  };
  localStorage.setItem("eliza:tutorial-state", JSON.stringify(persisted));
  const { getTutorialState } = await import("./tutorial-service");
  expect(getTutorialState()).toEqual(persisted);
  expect(getTutorialState()).toBe(getTutorialState());
});

it("normalizes malformed persisted fields without crashing boot", async () => {
  localStorage.setItem(
    "eliza:tutorial-state",
    JSON.stringify({
      status: "unknown",
      stepIndex: -1,
      startedAt: "yesterday",
      completedStepIds: null,
    }),
  );
  const { getTutorialState } = await import("./tutorial-service");
  expect(getTutorialState()).toEqual({
    status: "idle",
    stepIndex: 0,
    startedAt: null,
    completedStepIds: [],
  });
});

it("retains completion from older installs without rewriting their saved flag", async () => {
  localStorage.setItem("eliza:tutorial-completed", "1");
  const tour = await import("./tutorial-service");
  expect(tour.getTutorialState().status).toBe("completed");
  expect(localStorage.getItem("eliza:tutorial-completed")).toBe("1");
  expect(localStorage.getItem("eliza:tutorial-state")).toBeNull();
});

it("prefers a current explicit restart over legacy completion", async () => {
  localStorage.setItem("eliza:tutorial-completed", "1");
  localStorage.setItem(
    "eliza:tutorial-state",
    JSON.stringify({
      status: "active",
      stepIndex: 1,
      startedAt: 123,
      completedStepIds: [TUTORIAL_STEP_IDS[0]],
    }),
  );
  const tour = await import("./tutorial-service");
  expect(tour.getTutorialState()).toMatchObject({
    status: "active",
    stepIndex: 1,
  });
});
