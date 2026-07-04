/**
 * Unit tests for the tutorial step model: buildTutorialSteps returns the eight
 * frames in order (branded with the app name, targeting real controls), the
 * new-chat and swipe auto-advance predicates fire only on the right
 * conversation transition, and each frame's capability lock permits its own
 * tabs while blocking off-path ones. Pure functions + nav-lock state.
 */

import { afterEach, describe, expect, it } from "vitest";
import { isNavAllowed, setNavLock } from "../../../navigation/nav-lock";
import {
  buildTutorialSteps,
  TUTORIAL_STEPS,
  type TutorialObservable,
} from "./tutorial-steps";

function observable(
  over: Partial<TutorialObservable> = {},
): TutorialObservable {
  return {
    tab: "home",
    detent: null,
    composerText: "",
    transcript: "",
    prefillSent: false,
    newConversationStarted: false,
    conversationSwitched: false,
    secondsOnStep: 0,
    ...over,
  };
}

afterEach(() => setNavLock(null));

describe("buildTutorialSteps", () => {
  it("returns the eight frames in order (incl. new-chat + swipe)", () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual([
      "welcome",
      "open-chat",
      "resize-chat",
      "ask-to-navigate",
      "use-voice",
      "new-chat",
      "swipe-between-chats",
      "done",
    ]);
  });

  it("brands the copy with the app name", () => {
    const steps = buildTutorialSteps("My App");
    expect(steps[0].title).toBe("Meet My App");
  });

  it("carries no stale 'Tutorial tile' launch copy", () => {
    const blob = JSON.stringify(buildTutorialSteps());
    expect(blob).not.toMatch(/Tutorial tile/i);
  });

  it("targets real controls for the two new frames", () => {
    const byId = Object.fromEntries(TUTORIAL_STEPS.map((s) => [s.id, s]));
    expect(byId["new-chat"].targetSelector).toBe(
      '[data-testid="shell-new-chat"]',
    );
    expect(byId["swipe-between-chats"].targetSelector).toBe(
      '[data-testid="chat-sheet"]',
    );
  });
});

describe("new-frame auto-advance predicates", () => {
  const byId = Object.fromEntries(TUTORIAL_STEPS.map((s) => [s.id, s]));

  it("new-chat advances only once a fresh conversation starts", () => {
    const step = byId["new-chat"];
    expect(step.isDone?.(observable())).toBe(false);
    expect(step.isDone?.(observable({ newConversationStarted: true }))).toBe(
      true,
    );
  });

  it("swipe-between-chats advances only on a conversation switch", () => {
    const step = byId["swipe-between-chats"];
    expect(step.isDone?.(observable())).toBe(false);
    expect(step.isDone?.(observable({ conversationSwitched: true }))).toBe(
      true,
    );
  });
});

describe("per-frame capability lock", () => {
  // The engine applies setNavLock(step.lockTabs ?? ["chat"]) per frame. Each
  // frame must permit its own path and its staged navigateOnDone target, and
  // block an unrelated tab — so nothing drifts the app off the guided route.
  it("permits the frame's own tabs and blocks an off-path tab", () => {
    for (const step of TUTORIAL_STEPS) {
      const allowed = step.lockTabs ?? ["chat"];
      setNavLock(allowed);
      for (const tab of allowed) {
        expect(isNavAllowed(tab), `${step.id} allows ${tab}`).toBe(true);
      }
      if (step.navigateOnDone) {
        expect(
          isNavAllowed(step.navigateOnDone),
          `${step.id} allows its navigateOnDone target`,
        ).toBe(true);
      }
      expect(
        isNavAllowed("definitely-not-a-tour-tab"),
        `${step.id} blocks an off-path tab`,
      ).toBe(false);
    }
  });
});
