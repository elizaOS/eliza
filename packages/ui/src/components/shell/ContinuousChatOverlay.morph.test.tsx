// @vitest-environment jsdom
//
// Regression suite for the chat-widget polish pass: the pill hard-shrink scale
// lerp, the follow-the-finger contract after an over-pull past the top of the
// screen, the recording-aware handle glow (pill pulses, open-sheet grabber
// stays quiet), the handle fade through the maximize over-pull, and the pinned
// chat-column width through the maximize morph. Renders the real overlay in
// jsdom with the API client mocked; gesture velocity is controlled by mocking
// performance.now (jsdom otherwise reads every move as a flick).

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  client: {
    fetch: vi.fn().mockRejectedValue(new Error("no api in test")),
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
    searchConversationMessages: vi.fn(),
  },
}));

import {
  ContinuousChatOverlay,
  grabberBarOpacity,
  PILL_MORPH_MIN_SCALE,
  pillMorphScale,
} from "./ContinuousChatOverlay";
import type { ShellController } from "./useShellController";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
});

function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    messages: [
      { id: "a", role: "assistant", content: "hi there", createdAt: 1 },
      { id: "b", role: "user", content: "hello", createdAt: 2 },
    ],
    canSend: true,
    responding: false,
    turnStatus: null,
    recording: false,
    transcript: "",
    transcriptionMode: false,
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    toggleTranscriptionMode: vi.fn(),
    stopTranscriptionAndMic: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    clearConversation: vi.fn(),
    ...overrides,
  } as unknown as ShellController;
}

/** Await one animation frame so the gesture rAF-coalescer delivers a
 *  mid-gesture pointermove (release-time moves are flushed synchronously, but
 *  a sequence that must be OBSERVED in order — e.g. an over-pull then a
 *  reversal — needs each critical sample delivered before the next). */
const frame = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => resolve());
    } else {
      resolve();
    }
  });

const grabber = () => screen.getByTestId("chat-sheet-grabber");
const sheet = () => screen.getByTestId("chat-sheet");
const grabberBar = () => grabber().querySelector("span");
const pillBar = () => screen.getByTestId("chat-pill").querySelector("span");

function flick(el: Element, fromY: number, toY: number): void {
  const now = vi.spyOn(performance, "now");
  now.mockReturnValue(0);
  fireEvent.pointerDown(el, { clientY: fromY, pointerId: 1 });
  now.mockReturnValue(1);
  fireEvent.pointerMove(el, { clientY: toY, pointerId: 1 });
  now.mockReturnValue(2);
  fireEvent.pointerUp(el, { clientY: toY, pointerId: 1 });
  now.mockRestore();
}

// A slow over-pull far past the FULL detent (longHaul ≥ 80% of the viewport)
// that commits edge-to-edge maximize on release (#13531).
function bigPullUp(el: Element): void {
  const now = vi.spyOn(performance, "now");
  now.mockReturnValue(0);
  fireEvent.pointerDown(el, { clientY: 760, pointerId: 1 });
  now.mockReturnValue(200);
  fireEvent.pointerMove(el, { clientY: 400, pointerId: 1 });
  now.mockReturnValue(400);
  fireEvent.pointerMove(el, { clientY: 40, pointerId: 1 });
  now.mockReturnValue(800);
  fireEvent.pointerMove(el, { clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(el, { clientY: 0, pointerId: 1 });
  now.mockRestore();
}

describe("pill collapse hard-shrink scale (pillMorphScale)", () => {
  it("lerps the panel scale across the FULL range down to the pill scale", () => {
    // The collapse must be a real scale-down into the capsule — the old
    // [0.9, 1] mapping read as "barely animates down".
    expect(pillMorphScale(1)).toBe(1);
    expect(pillMorphScale(0)).toBe(PILL_MORPH_MIN_SCALE);
    expect(PILL_MORPH_MIN_SCALE).toBeLessThanOrEqual(0.5);
    // Monotonic and continuous through the middle of the morph.
    expect(pillMorphScale(0.5)).toBeCloseTo(
      PILL_MORPH_MIN_SCALE + (1 - PILL_MORPH_MIN_SCALE) * 0.5,
      10,
    );
    // Out-of-range progress clamps instead of over/under-scaling.
    expect(pillMorphScale(-1)).toBe(PILL_MORPH_MIN_SCALE);
    expect(pillMorphScale(2)).toBe(1);
  });
});

describe("handle fade through the maximize over-pull (grabberBarOpacity)", () => {
  it("fades the handle out as the over-pull shape morph approaches full-bleed", () => {
    // Fully open input, no over-pull → fully visible.
    expect(grabberBarOpacity(1, 0)).toBe(1);
    // Half way through the over-pull morph → half faded.
    expect(grabberBarOpacity(1, 0.5)).toBeCloseTo(0.5, 10);
    // At edge-to-edge the bar has fully dissolved — the maximize commit that
    // unmounts it for the restore strip is invisible (no pop).
    expect(grabberBarOpacity(1, 1)).toBe(0);
  });

  it("keeps the strict anti-phase crossfade with the pill capsule", () => {
    // While the pill still owns the bottom (openProgress ≤ 0.55) the grabber
    // bar stays hidden regardless of the shape morph — the "two pills" guard.
    expect(grabberBarOpacity(0, 0)).toBe(0);
    expect(grabberBarOpacity(0.55, 0)).toBe(0);
    expect(grabberBarOpacity(0.95, 0)).toBeCloseTo(1, 10);
  });
});

describe("follow-the-finger after an over-pull past the top (overshoot rebase)", () => {
  it("tracks the pointer 1:1 back down after pulling beyond the screen top", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const el = grabber();

    // jsdom viewport: innerHeight 768 → insetPanelMaxH 696, full ceiling 768,
    // halfH 353, detent magnet 64.
    const threadBasis = () =>
      (screen.queryByTestId("chat-thread") as HTMLElement | null)?.style
        .flexBasis;
    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(0);
    fireEvent.pointerDown(el, { clientY: 800, pointerId: 1 });
    now.mockReturnValue(200);
    fireEvent.pointerMove(el, { clientY: 500, pointerId: 1 }); // up 300
    await frame();
    // Pull far BEYOND the full-bleed ceiling (up 1032 > 768): the excess must
    // be CONSUMED, not banked. Wait for the observable style so the sample is
    // provably DELIVERED (the coalescer + framer each apply on their own rAF)
    // before reversing — the reversal must be seen as a later frame.
    now.mockReturnValue(400);
    fireEvent.pointerMove(el, { clientY: -232, pointerId: 1 });
    await waitFor(() => expect(threadBasis()).toBe("768px"));
    // Reverse back down into the canvas — SLOWLY (whole-press AND final-segment
    // velocity must stay under the 0.5 px/ms flick threshold, or the release
    // reads as an upward flick and legitimately steps to a detent). With the
    // overshoot consumed, the sheet height is finger-locked again immediately:
    // the release height is ceiling − reversal (768 − 332 = 436), NOT
    // start-relative 700.
    now.mockReturnValue(2000);
    fireEvent.pointerMove(el, { clientY: 90, pointerId: 1 });
    await frame();
    now.mockReturnValue(2900);
    fireEvent.pointerMove(el, { clientY: 100, pointerId: 1 });
    now.mockReturnValue(3000); // 700px net over 3s ⇒ deliberate drag ⇒ free-rest
    fireEvent.pointerUp(el, { clientY: 100, pointerId: 1 });
    now.mockRestore();

    // 436px is in the open gap between HALF (353) and FULL (696), outside the
    // 64px detent magnets → the sheet rests exactly where the finger left it
    // and the label folds to "half". Under the old banked-overshoot math the
    // un-consumed excess held the height at ~700 → this read "full" (or even
    // re-maximized off the abandoned peak).
    expect(sheet().getAttribute("data-detent")).toBe("half");
    expect(sheet().getAttribute("data-chat-state")).toBe("OPEN_HALF_OR_OVER");
    expect(sheet().getAttribute("data-maximized")).toBeNull();
  });
});

describe("handle glow while recording (pill-only pulse)", () => {
  it("does NOT pulse the open-sheet grabber while recording", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          phase: "listening",
          recording: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(grabberBar()?.className ?? "").not.toContain("animate-pulse");
  });

  it("still pulses the grabber for a streaming reply when the mic is cold", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          responding: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(grabberBar()?.className ?? "").toContain("animate-pulse");
  });

  it("pulses the PILL while recording once minimized (the only voice cue left)", () => {
    render(
      <ContinuousChatOverlay
        controller={makeController({
          recording: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    // Collapse the input down to the pill.
    flick(grabber(), 200, 260);
    expect(sheet().getAttribute("data-detent")).toBe("pill");
    expect(pillBar()?.className ?? "").toContain("animate-pulse");
    expect(pillBar()?.className ?? "").toContain("bg-accent");
  });
});

describe("chat column width is pinned through maximize (no spread, no reflow)", () => {
  it("keeps the inner reading column at mx-auto max-w-3xl when open and at full-bleed", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    // The chat COLUMN is pinned on the inner rows (thread + composer both carry
    // `mx-auto max-w-3xl`), NOT on chat-content — chat-content spans the full
    // glass so the restore-drag strip and drag-drop intake cover the whole
    // panel at full-bleed. Assert that the reading column stays centered at its
    // reading width whether open at a detent or edge-to-edge maximized; only
    // the glass grows. (The thread mounts only when the sheet is open.)
    flick(grabber(), 400, 300); // pull up from the input bar → open
    const threadClass = () => screen.getByTestId("chat-thread").className;
    expect(threadClass()).toContain("mx-auto");
    expect(threadClass()).toContain("max-w-3xl");

    // Maximize via the long-haul over-pull gesture (#13531).
    bigPullUp(grabber());
    expect(sheet().getAttribute("data-maximized")).toBe("true");
    expect(threadClass()).toContain("mx-auto");
    expect(threadClass()).toContain("max-w-3xl");
  });
});
