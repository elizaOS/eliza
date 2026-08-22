/** Verifies pill collapse hard-shrink scale (pillMorphScale) through the package's configured test harness. */
// @vitest-environment jsdom
//
// Regression suite for the chat-widget polish pass: the pill hard-shrink scale
// lerp, the follow-the-finger contract after an over-pull past the top of the
// screen, the recording-aware handle breath (pill breathes, open-sheet grabber
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
  ChatOverlay,
  desktopPillTravelerOffset,
  desktopPillTravelerOpacity,
  desktopSheetGrabberOpacity,
  grabberBarOpacity,
  PILL_MORPH_MIN_SCALE,
  pillHandleCounterScale,
  pillMorphScale,
  sheetBlackoutProgress,
} from "./ChatOverlay";
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

describe("constant-size pill handle (pillHandleCounterScale)", () => {
  it("cancels the panel scale exactly at every morph progress", () => {
    // The pill capsule rides the panel's hard-shrink scale; the counter-scale
    // must invert it at EVERY point of the morph so the visible handle bar
    // never changes size between the collapsed pill and the input bar.
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1, -1, 2]) {
      expect(pillMorphScale(p) * pillHandleCounterScale(p)).toBeCloseTo(1, 10);
    }
  });

  it("shrinks the grabber bar once the sheet is OPEN (quieter handle over the transcript)", () => {
    render(<ChatOverlay controller={makeController()} />);
    // Open to HALF via a grabber tap.
    fireEvent.pointerDown(grabber(), { clientY: 420, pointerId: 1 });
    fireEvent.pointerUp(grabber(), { clientY: 420, pointerId: 1 });
    expect(sheet().getAttribute("data-detent")).toBe("half");
    const bar = grabberBar();
    expect(bar?.classList.contains("h-1")).toBe(true);
    expect(bar?.classList.contains("w-9")).toBe(true);
    expect(bar?.classList.contains("h-1.5")).toBe(false);
    expect(bar?.classList.contains("w-12")).toBe(false);
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

describe("detached desktop pill traveler handoff", () => {
  it("stays bottom-anchored at rest and lands on the 64px input top edge", () => {
    expect(desktopPillTravelerOffset(0, 64, 12)).toBe(0);
    expect(desktopPillTravelerOffset(0.5, 64, 12)).toBe(-26);
    expect(desktopPillTravelerOffset(1, 64, 12)).toBe(-52);
  });

  it("keeps exactly one mark painted while handing off to the grabber", () => {
    for (const travelerOwns of [true, false]) {
      const traveler = desktopPillTravelerOpacity(travelerOwns, 0);
      const fixedGrabber = desktopSheetGrabberOpacity(travelerOwns, 0);
      expect(traveler + fixedGrabber).toBe(1);
      expect(traveler * fixedGrabber).toBe(0);
    }
  });

  it("keeps the traveler visible at the fully formed input endpoint", () => {
    expect(desktopPillTravelerOpacity(true, 0)).toBe(1);
    expect(desktopSheetGrabberOpacity(true, 0)).toBe(0);
  });

  it("never resurrects the traveler in full bleed", () => {
    expect(desktopPillTravelerOpacity(true, 1)).toBe(0);
    expect(desktopPillTravelerOpacity(false, 1)).toBe(0);
    expect(desktopSheetGrabberOpacity(false, 1)).toBe(0);
  });
});

describe("open-sheet blackout (sheetBlackoutProgress)", () => {
  it("keeps the resting glass at zero reveal and lands opaque at the half detent", () => {
    // Closed thread: the composer keeps the translucent glass fill.
    expect(sheetBlackoutProgress(0, 353, 0)).toBe(0);
    // Mid-drag: the blend tracks the revealed height continuously.
    expect(sheetBlackoutProgress(176.5, 353, 0)).toBeCloseTo(0.5, 10);
    // At (and past) HALF the fill is fully the opaque panel --bg.
    expect(sheetBlackoutProgress(353, 353, 0)).toBe(1);
    expect(sheetBlackoutProgress(700, 353, 0)).toBe(1);
  });

  it("folds the maximize shape morph in so full-bleed can never read MORE translucent", () => {
    expect(sheetBlackoutProgress(0, 353, 1)).toBe(1);
    expect(sheetBlackoutProgress(100, 353, 0.8)).toBeCloseTo(0.8, 10);
  });

  it("treats a degenerate half detent as no reveal instead of dividing by zero", () => {
    expect(sheetBlackoutProgress(200, 0, 0)).toBe(0);
    expect(sheetBlackoutProgress(200, 0, 0.4)).toBeCloseTo(0.4, 10);
  });

  it("blends a stable compositor child to opaque once the drag crosses the half detent", async () => {
    render(<ChatOverlay controller={makeController()} />);
    const el = grabber();
    const surface = () =>
      screen.getByTestId("chat-sheet-surface") as HTMLElement;
    const blackout = () =>
      screen.getByTestId("chat-sheet-blackout") as HTMLElement;
    const restingSurfaceFill = surface().style.backgroundColor;

    const now = vi.spyOn(performance, "now");
    const eventTime = vi
      .spyOn(Event.prototype, "timeStamp", "get")
      .mockImplementation(() => performance.now() || Number.MIN_VALUE);
    now.mockReturnValue(0);
    fireEvent.pointerDown(el, { clientY: 800, pointerId: 1 });
    // jsdom viewport: halfH is 353 — drag the thread 500px up, past HALF.
    now.mockReturnValue(400);
    fireEvent.pointerMove(el, { clientY: 300, pointerId: 1 });
    await waitFor(() => expect(blackout().style.opacity).toBe("1"));
    expect(surface().style.backgroundColor).toBe(restingSurfaceFill);
    now.mockReturnValue(3000);
    fireEvent.pointerUp(el, { clientY: 300, pointerId: 1 });
    eventTime.mockRestore();
    now.mockRestore();

    // Resting open past HALF (a deliberate drag free-rests where the finger
    // left it): the blackout holds — no glass re-frost.
    await waitFor(() => {
      expect(sheet().getAttribute("data-chat-state")).toBe("OPEN_HALF_OR_OVER");
      expect(blackout().style.opacity).toBe("1");
      expect(surface().style.backgroundColor).toBe(restingSurfaceFill);
    });
  });
});

describe("follow-the-finger after an over-pull past the top (overshoot rebase)", () => {
  it("tracks the pointer 1:1 back down after pulling beyond the screen top", async () => {
    render(<ChatOverlay controller={makeController()} />);
    const el = grabber();

    // jsdom viewport: innerHeight 768 → insetPanelMaxH 696, full ceiling 768,
    // halfH 353, detent magnet 64.
    const threadBasis = () =>
      (screen.queryByTestId("chat-thread") as HTMLElement | null)?.style
        .flexBasis;
    const now = vi.spyOn(performance, "now");
    const eventTime = vi
      .spyOn(Event.prototype, "timeStamp", "get")
      .mockImplementation(() => performance.now() || Number.MIN_VALUE);
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
    await waitFor(() => expect(threadBasis()).toBe("446px"));
    now.mockReturnValue(2900);
    fireEvent.pointerMove(el, { clientY: 100, pointerId: 1 });
    await waitFor(() => expect(threadBasis()).toBe("436px"));
    now.mockReturnValue(3000); // 700px net over 3s ⇒ deliberate drag ⇒ free-rest
    fireEvent.pointerUp(el, { clientY: 100, pointerId: 1 });
    eventTime.mockRestore();
    now.mockRestore();

    // 436px is in the open gap between HALF (353) and FULL (696), outside the
    // 64px detent magnets → the sheet rests exactly where the finger left it
    // and the label folds to "half". Under the old banked-overshoot math the
    // un-consumed excess held the height at ~700 → this read "full" (or even
    // re-maximized off the abandoned peak).
    await waitFor(() => {
      expect(sheet().getAttribute("data-detent")).toBe("half");
      expect(sheet().getAttribute("data-chat-state")).toBe("OPEN_HALF_OR_OVER");
      expect(sheet().getAttribute("data-maximized")).toBeNull();
    });
  });
});

describe("handle glow while recording (pill-only pulse)", () => {
  it("does NOT pulse the open-sheet grabber while recording", () => {
    render(
      <ChatOverlay
        controller={makeController({
          phase: "listening",
          recording: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(grabberBar()?.className ?? "").not.toContain("animate-pulse");
  });

  it("breathes the grabber for a streaming reply when the mic is cold", () => {
    render(
      <ChatOverlay
        controller={makeController({
          responding: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    expect(grabberBar()?.className ?? "").toContain(
      "eliza-chat-handle-breathe",
    );
    expect(grabberBar()?.className ?? "").not.toContain("animate-pulse");
  });

  it("breathes the PILL in white while recording once minimized", () => {
    render(
      <ChatOverlay
        controller={makeController({
          recording: true,
        } as unknown as Partial<ShellController>)}
      />,
    );
    // Collapse the input down to the pill.
    flick(grabber(), 200, 260);
    expect(sheet().getAttribute("data-detent")).toBe("pill");
    expect(pillBar()?.className ?? "").toContain("eliza-chat-handle-breathe");
    expect(pillBar()?.className ?? "").not.toContain("animate-pulse");
    expect(pillBar()?.className ?? "").not.toContain("bg-accent");
    expect(pillBar()?.style.backgroundColor).toBe("rgba(255, 255, 255, 0.96)");
  });
});
