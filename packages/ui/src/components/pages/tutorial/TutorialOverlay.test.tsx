// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Collaborators are mocked; the UNIT under test is the real tour engine
// (TutorialOverlay) driving the real module-level step store (tutorial-controller)
// and the real spotlight targeting (TutorialSpotlight). We only stub the things
// the engine talks TO: the app-state selector (tab / setTab), branding, the
// shell controller (voice), the chat-control event bus, and the voice narrator.
// ---------------------------------------------------------------------------

type AppState = { tab: string; setTab: (t: string) => void };
const appMock = vi.hoisted(() => ({
  value: { tab: "chat", setTab: () => {} } as AppState,
}));

vi.mock("../../../state", () => ({
  useAppSelector: (sel: (s: AppState) => unknown) => sel(appMock.value),
}));

// Stable branding so useMemo(buildTutorialSteps) never re-mints the step array.
vi.mock("../../../config/branding", () => ({
  useBranding: () => ({ appName: "Eliza" }),
}));

const controllerMock = vi.hoisted(() => ({
  value: { transcript: "", unlockAudio: vi.fn() },
}));
vi.mock("../../shell/ShellControllerContext.hooks", () => ({
  useShellControllerContext: () => controllerMock.value,
}));

const dispatchChat = vi.hoisted(() => vi.fn());
vi.mock("../../../events", () => ({
  dispatchTutorialChatControl: dispatchChat,
}));

// The narrator performs real TTS/voice side effects — not the unit. Render nil.
vi.mock("./TutorialNarrator", () => ({ TutorialNarrator: () => null }));

import { TutorialOverlay } from "./TutorialOverlay";
import { buildTutorialSteps } from "./tutorial-steps";
import {
  goToStep,
  startTutorial,
  stopTutorial,
  useTutorial,
} from "./tutorial-controller";

const STEPS = buildTutorialSteps("Eliza");
const LAST_INDEX = STEPS.length - 1;
const COMPLETED_KEY = "eliza:tutorial-completed";

/** Probe that surfaces the real store state as DOM so tests assert on the
 *  actual tracked step, not just rendered copy. */
function Probe(): React.ReactElement {
  const { active, stepIndex } = useTutorial();
  return (
    <div
      data-testid="probe"
      data-active={String(active)}
      data-step={String(stepIndex)}
    />
  );
}

function renderTour() {
  return render(
    <>
      <Probe />
      <TutorialOverlay />
    </>,
  );
}

const probe = () =>
  document.querySelector('[data-testid="probe"]') as HTMLElement;
const card = () =>
  document.querySelector('[data-testid="tutorial-card"]') as HTMLElement | null;
const spotlight = () =>
  document.querySelector(
    '[data-testid="tutorial-spotlight"]',
  ) as HTMLElement | null;
const cardTitle = () => card()?.querySelector("h3")?.textContent ?? null;
const continueBtn = () =>
  document.querySelector(
    '[data-testid="tutorial-continue"]',
  ) as HTMLButtonElement | null;
const skipBtn = () =>
  document.querySelector(
    '[data-testid="tutorial-skip"]',
  ) as HTMLButtonElement;

beforeEach(() => {
  // The store is a globalThis singleton that survives across tests — reset it.
  act(() => stopTutorial());
  localStorage.clear();
  appMock.value = { tab: "chat", setTab: vi.fn() };
  controllerMock.value = { transcript: "", unlockAudio: vi.fn() };
  dispatchChat.mockClear();
});

afterEach(() => {
  cleanup();
  act(() => stopTutorial());
  localStorage.clear();
});

describe("TutorialOverlay — tour engine", () => {
  it("self-hides while inactive and mounts the current frame on start", () => {
    renderTour();
    // Inactive store => the always-mounted overlay renders nothing.
    expect(card()).toBeNull();
    expect(spotlight()).toBeNull();
    expect(probe().getAttribute("data-active")).toBe("false");

    act(() => startTutorial());

    expect(probe().getAttribute("data-active")).toBe("true");
    expect(probe().getAttribute("data-step")).toBe("0");
    expect(cardTitle()).toBe(STEPS[0].title); // "Meet Eliza"
  });

  it("Continue advances the tracked step exactly one frame", () => {
    renderTour();
    act(() => startTutorial());
    expect(probe().getAttribute("data-step")).toBe("0");

    // The welcome frame is a manual-continue card labelled "Start".
    const btn = continueBtn();
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toBe("Start");

    fireEvent.click(btn as HTMLButtonElement);

    // Advanced to frame 1 (open-chat) — one step, not more.
    expect(probe().getAttribute("data-step")).toBe("1");
    expect(cardTitle()).toBe(STEPS[1].title); // "Open the chat"
  });

  it("Skip dismisses the tour and persists completion", () => {
    renderTour();
    act(() => startTutorial());
    act(() => goToStep(1)); // mid-tour, an action frame
    expect(card()).not.toBeNull();
    expect(localStorage.getItem(COMPLETED_KEY)).toBeNull();

    fireEvent.click(skipBtn());

    // Overlay self-hides (returns null) and marks the tour done.
    expect(card()).toBeNull();
    expect(spotlight()).toBeNull();
    expect(probe().getAttribute("data-active")).toBe("false");
    expect(probe().getAttribute("data-step")).toBe("0");
    expect(localStorage.getItem(COMPLETED_KEY)).toBe("1");
  });

  it("finishing the last frame completes + persists, and cannot overshoot", () => {
    renderTour();
    act(() => startTutorial());
    act(() => goToStep(LAST_INDEX)); // final "You're set" frame
    expect(cardTitle()).toBe(STEPS[LAST_INDEX].title);
    const btn = continueBtn();
    expect(btn?.textContent).toBe("Done"); // isLast => "Done"

    fireEvent.click(btn as HTMLButtonElement);

    // advance() guards the last frame: it stops the tour rather than indexing
    // past the end into an undefined step.
    expect(probe().getAttribute("data-active")).toBe("false");
    expect(probe().getAttribute("data-step")).toBe("0");
    expect(card()).toBeNull();
    expect(localStorage.getItem(COMPLETED_KEY)).toBe("1");
  });

  it("rapid double-click on Continue does not overshoot past the next frame", () => {
    renderTour();
    act(() => startTutorial());
    const btn = continueBtn() as HTMLButtonElement;

    // Fire twice in immediate succession. The welcome continue only advances
    // welcome->open-chat; the second (stale) click must not push us to frame 2.
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(probe().getAttribute("data-step")).toBe("1");
    expect(cardTitle()).toBe(STEPS[1].title); // "Open the chat", never "Resize it"

    // And the action frame we landed on exposes NO continue button, so a further
    // click cannot fast-forward through frames that require a real action.
    expect(continueBtn()).toBeNull();
  });
});

describe("TutorialSpotlight targeting via the engine", () => {
  it("marks the target missing when the spotlighted control isn't on screen", () => {
    renderTour();
    act(() => startTutorial());
    act(() => goToStep(1)); // open-chat targets [data-testid="chat-pill"]

    const step = STEPS[1];
    expect(step.targetSelector).toBe('[data-testid="chat-pill"]');
    // No such control mounted in this jsdom tree => targeting surfaces a marker
    // instead of silently degrading to a full-screen dim.
    expect(spotlight()?.getAttribute("data-tutorial-target-missing")).toBe(
      step.targetSelector,
    );
  });

  it("centered frames (no target) carry no target-missing marker", () => {
    renderTour();
    act(() => startTutorial()); // welcome: targetSelector === null

    expect(STEPS[0].targetSelector).toBeNull();
    expect(
      spotlight()?.getAttribute("data-tutorial-target-missing"),
    ).toBeNull();
  });
});

describe("tutorial-controller store invariants", () => {
  it("clamps step index at zero (no underflow)", () => {
    act(() => startTutorial());
    act(() => goToStep(-5));
    // Rendered via a probe to read the real store.
    render(<Probe />);
    expect(probe().getAttribute("data-step")).toBe("0");
  });
});
