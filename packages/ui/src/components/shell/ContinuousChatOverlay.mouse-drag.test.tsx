// @vitest-environment jsdom
//
// Adversarial MOUSE-DRAG suite for the chat sheet's follow-the-finger contract,
// the cases a real cursor can produce that a well-behaved flick never does:
//
//   A. drag UP ~200% above the screen, then all the way back DOWN to the
//      bottom → the sheet must COLLAPSE (it ended at the bottom), never strand
//      open or maximized.
//   B. over-drag DOWN ~200% below the screen, then all the way UP to the top →
//      the sheet must MAXIMIZE (the finger reached the top edge).
//   C. oscillate UP/DOWN 3× across the detents → the panel height tracks the
//      cursor 1:1 the whole time (no lag, no dead zones, no stuck detent).
//   D. oscillate high (past the maximize threshold) then release at the BOTTOM
//      → must NOT surprise-maximize off a stale peak; releasing low collapses.
//
// jsdom has no real layout (getBoundingClientRect is 0), so the panel height IS
// the `threadHeight` motion value, published as the chat-thread flex-basis — a
// faithful readout of the drag MATH (raw = dragBase + offset, clamped/consumed
// at the ceiling). We drive velocity by mocking performance.now: every gesture
// here ends with a stationary final segment so it reads as a DELIBERATE drag
// (onSettleFree), the "release where the finger is" path a mouse produces —
// never an accidental flick.
//
// jsdom viewport: innerHeight 768 → insetPanelMaxH (FULL detent) 696, full-bleed
// ceiling 768, halfH 353, detent magnet 64.

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

import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
import type { ShellController } from "./useShellController";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

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

const grabber = () => screen.getByTestId("chat-sheet-grabber");
const sheet = () => screen.getByTestId("chat-sheet");
const detent = () => sheet().getAttribute("data-detent");
const maximized = () => sheet().getAttribute("data-maximized");
const variant = () => sheet().getAttribute("data-variant");

/** Current tracked panel height (chat-thread flex-basis) in px, or null when the
 *  thread isn't mounted (resting collapsed). */
function basisPx(): number | null {
  const b = (screen.queryByTestId("chat-thread") as HTMLElement | null)?.style
    .flexBasis;
  if (!b) return null;
  const n = Number.parseFloat(b);
  return Number.isFinite(n) ? n : null;
}

/** Flush a few animation frames so the rAF gesture-coalescer delivers the last
 *  pointermove and framer applies the resulting transform — WITHOUT assuming the
 *  thread is mounted (a gesture through the pill unmounts it). */
async function settleFrames(n = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await new Promise<void>((resolve) => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => resolve());
      } else {
        resolve();
      }
    });
  }
}

/** A gesture driver bound to one mocked clock. `.move()` advances the clock and
 *  dispatches a pointermove, then flushes frames so the coalescer delivers it.
 *  `.moveTracks()` additionally asserts the tracked height matches the cursor. */
function drag(el: Element) {
  const now = vi.spyOn(performance, "now");
  let t = 0;
  now.mockReturnValue(0);
  return {
    down(y: number) {
      fireEvent.pointerDown(el, { clientY: y, pointerId: 1 });
      return this;
    },
    async move(y: number, dtMs = 300) {
      t += dtMs;
      now.mockReturnValue(t);
      fireEvent.pointerMove(el, { clientY: y, pointerId: 1 });
      await settleFrames();
      return this;
    },
    /** Move to `y` and assert the tracked height lands near `expected` (1:1). */
    async moveTracks(y: number, expected: number, tol = 4, dtMs = 300) {
      t += dtMs;
      now.mockReturnValue(t);
      fireEvent.pointerMove(el, { clientY: y, pointerId: 1 });
      await waitFor(() => {
        const b = basisPx();
        expect(b).not.toBeNull();
        expect(Math.abs((b as number) - expected)).toBeLessThanOrEqual(tol);
      });
      return this;
    },
    /** Release deliberately: a stationary final segment (0 velocity) so the
     *  gesture engine reads a slow drag (onSettleFree), never a flick. */
    up(y: number) {
      t += 400; // long, stationary tail ⇒ deliberate release
      now.mockReturnValue(t);
      fireEvent.pointerUp(el, { clientY: y, pointerId: 1 });
      now.mockRestore();
    },
  };
}

describe("layout-shift-intent marker (#15257)", () => {
  it("a continuous drag arms the marker ONCE, not per height tick", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const el = grabber();
    const setAttr = vi.spyOn(Element.prototype, "setAttribute");
    try {
      fireEvent.pointerDown(el, { clientY: 740, pointerId: 1 });
      // 20 move ticks well inside the 180ms clear window (real clock): every
      // tick refreshes the armed marker; only the FIRST may write the attribute.
      for (let i = 1; i <= 20; i++) {
        fireEvent.pointerMove(el, { clientY: 740 - i * 12, pointerId: 1 });
      }
      await settleFrames();
      const markerWrites = setAttr.mock.calls.filter(
        ([name]) => name === "data-eliza-layout-shift-intent",
      ).length;
      expect(markerWrites).toBeLessThanOrEqual(1);
      fireEvent.pointerUp(el, { clientY: 500, pointerId: 1 });
    } finally {
      setAttr.mockRestore();
    }
  });
});

describe("adversarial mouse drags — up/down 200%, back-and-forth", () => {
  it("A) up ~200% above the screen then all the way back to the bottom COLLAPSES (not stranded open/maximized)", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const g = drag(grabber()).down(740);
    // Up past the ceiling …
    await g.move(200); // up 540
    // … to ~200% above the screen top (up ~1540, ~2× the 768 viewport).
    await g.move(-800);
    // Then all the way back down to the very bottom of the screen.
    await g.move(300);
    await g.move(760); // at the bottom edge
    g.up(760);

    // The finger ended at the bottom → the chat is put away. It must NOT be
    // stranded open, and MUST NOT have stuck in full-bleed off the over-pull.
    expect(maximized()).toBeNull();
    expect(variant()).not.toBe("open");
    expect(["pill", "collapsed"]).toContain(detent());
  });

  it("B) over-drag DOWN ~200% then all the way UP to the top MAXIMIZES", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const g = drag(grabber()).down(300);
    // Down ~200% below the screen (past the bottom → collapses toward the pill).
    await g.move(1840); // down ~1540
    // Then all the way up to the very top edge — sampled finely (a real pointer
    // fires at ~60–120Hz), so the first upward sample sits right at the reversal
    // point and the full-screen up-pull is measured from the bottom, not from a
    // coarse mid-screen sample. A single coarse up-jump would rebase the
    // pill-reversal high up and under-count the travel.
    await g.move(1760);
    await g.move(1400);
    await g.move(1000);
    await g.move(600);
    await g.move(200);
    await g.move(0); // cursor at the top edge — a full-height pull
    g.up(0);

    // Reaching the top edge in one continuous pull is the maximize intent.
    expect(maximized()).toBe("true");
    expect(detent()).toBe("full");
    expect(variant()).toBe("open");
  });

  it("C) oscillating UP/DOWN 3× across the detents tracks the cursor 1:1", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    // Start near the bottom; every waypoint keeps the cursor ABOVE the press
    // point (offset > 0) so the open panel height == the upward offset, and the
    // peak stays under the 80%-viewport maximize threshold (614) so this is a
    // pure tracking test with no surprise commit. Offsets: 500,250,560,200,
    // 460,100 — crossing the HALF detent (353) both directions, 3× each way.
    const g = drag(grabber()).down(740);
    await g.moveTracks(240, 500); // up   → 500 (above half)
    await g.moveTracks(490, 250); // down → 250 (below half)
    await g.moveTracks(180, 560); // up   → 560
    await g.moveTracks(540, 200); // down → 200
    await g.moveTracks(280, 460); // up   → 460
    await g.moveTracks(640, 100); // down → 100
    g.up(640);
    // Tracking is the assertion (each moveTracks); the release just settles.
  });

  it("D) oscillating past the maximize threshold then releasing at the BOTTOM does not surprise-maximize", async () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const g = drag(grabber()).down(740);
    // Pull high — past 80% of the viewport (up 700 > 614) so the maximize
    // "long-haul" intent is armed …
    await g.move(40); // up 700
    // … but then bring the finger ALL the way back down to the bottom and let
    // go there. Ending low is an explicit "put it away", not a maximize.
    await g.move(400);
    await g.move(760);
    g.up(760);

    expect(maximized()).toBeNull();
    expect(variant()).not.toBe("open");
  });
});
