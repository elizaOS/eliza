/** Verifies free-rest release bands + detent magnetism (matrix: FREE / slow drag rows) through the package's configured test harness. */
// @vitest-environment jsdom
//
// State-matrix gap coverage for the continuous chat sheet — the rows of
// __e2e__/CHAT_SHEET_STATE_MATRIX.md that had no direct unit/e2e assertion:
// free-rest release bands and their ±64px detent-magnet edges, the restore
// drag's HALF/FREE landings, flick-down stepping from a free rest, the
// bottom-band INPUT-vs-PILL split, mid-band pill-drag releases, the maximize
// commit hysteresis, the one-haptic-per-detent invariant, and stale-state
// checks across consecutive gestures. Drives the real overlay in jsdom with
// the API client mocked; gesture velocity is controlled by mocking
// performance.now (jsdom otherwise reads every move as a flick).

import {
  act,
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
    getBaseUrl: vi.fn(() => ""),
    createTranscript: vi
      .fn()
      .mockResolvedValue({ transcript: { id: "t1", title: "Transcript" } }),
    searchConversationMessages: vi.fn(),
  },
}));

import { ChatOverlay } from "./ChatOverlay";
import { SHEET_TOP_MARGIN } from "./chat-panel-layout";
import type { ShellController } from "./useShellController";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
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

// Geometry the component derives from the jsdom viewport (innerHeight 768,
// no visualViewport, no safe-area, unmeasured bottom pad). Deriving the SAME
// numbers here keeps every band assertion exact instead of magic.
const VIEWPORT_H = 768;
const HALF_H = Math.round(VIEWPORT_H * 0.46); // 353
const INSET_FULL_H = VIEWPORT_H - SHEET_TOP_MARGIN; // 696
const MAGNET = 64;

const sheet = () => screen.getByTestId("chat-sheet");
const grabber = () => screen.getByTestId("chat-sheet-grabber");
const thread = () => screen.getByTestId("chat-thread");
const detent = () => sheet().getAttribute("data-detent");
const chatState = () => sheet().getAttribute("data-chat-state");
const maximized = () => sheet().getAttribute("data-maximized");
const variant = () => sheet().getAttribute("data-variant");

/** Await one animation frame so the gesture rAF-coalescer delivers each
 *  mid-gesture pointermove (release-time moves are flushed synchronously, but
 *  a sequence that must be OBSERVED in order — a reversal, a mid-drag commit —
 *  needs every critical sample delivered before the next). */
const frame = async (): Promise<void> => {
  await act(
    () =>
      new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          resolve();
        }
      }),
  );
};

/**
 * A deliberate SLOW drag: mocked monotonic clock + bridged event timestamps so
 * neither the whole-press nor the last-segment velocity reads as a flick
 * (< 0.5 px/ms). Y coordinates are absolute; the release lands on the last Y.
 * Awaits a frame per move so the rAF coalescer delivers every sample —
 * reversals and mid-drag commits are observed in order, as a real finger's
 * per-frame moves are.
 */
async function slowDrag(
  el: Element,
  ys: number[],
  pointerId = 41,
): Promise<void> {
  const now = vi.spyOn(performance, "now");
  const ts = vi
    .spyOn(Event.prototype, "timeStamp", "get")
    .mockImplementation(() => performance.now() || Number.MIN_VALUE);
  try {
    let t = 0;
    now.mockReturnValue(t);
    fireEvent.pointerDown(el, { clientY: ys[0], pointerId });
    await frame();
    for (let i = 1; i < ys.length; i += 1) {
      // 400ms per step keeps every segment velocity well under the flick
      // threshold even for a 160px step.
      t += 400;
      now.mockReturnValue(t);
      fireEvent.pointerMove(el, { clientY: ys[i], pointerId });
      await frame();
    }
    t += 400;
    now.mockReturnValue(t);
    fireEvent.pointerUp(el, { clientY: ys[ys.length - 1], pointerId });
  } finally {
    ts.mockRestore();
    now.mockRestore();
  }
}

/** A fast flick (synchronous events → huge velocity). */
function flick(el: Element, fromY: number, toY: number, pointerId = 42): void {
  fireEvent.pointerDown(el, { clientY: fromY, pointerId });
  fireEvent.pointerMove(el, { clientY: toY, pointerId });
  fireEvent.pointerUp(el, { clientY: toY, pointerId });
}

/**
 * Slow-drag the INPUT-state grabber up by exactly `px` of finger travel. The
 * drag integrator adds raw pointer deltas, so the released thread height ==
 * the total upward travel (clamped at the panel ceiling). Steps of ≤160px keep
 * it deliberate.
 */
async function slowPullUpBy(px: number): Promise<void> {
  const start = 760;
  const ys: number[] = [start];
  let travelled = 0;
  while (travelled < px) {
    travelled = Math.min(px, travelled + 160);
    ys.push(start - travelled);
  }
  await slowDrag(grabber(), ys);
}

/** Open the sheet to the HALF detent via a grabber tap. */
function openToHalf(): void {
  fireEvent.pointerDown(grabber(), { clientY: 420, pointerId: 43 });
  fireEvent.pointerUp(grabber(), { clientY: 420, pointerId: 43 });
  expect(detent()).toBe("half");
}

/** Over-pull far past FULL so the maximize commits (long-haul + over-pull). */
function bigPullUp(): void {
  const g = grabber();
  fireEvent.pointerDown(g, { clientY: 760, pointerId: 44 });
  fireEvent.pointerMove(g, { clientY: 400, pointerId: 44 });
  fireEvent.pointerMove(g, { clientY: 40, pointerId: 44 });
  fireEvent.pointerMove(g, { clientY: -40, pointerId: 44 });
  fireEvent.pointerUp(g, { clientY: -40, pointerId: 44 });
  expect(maximized()).toBe("true");
}

/** The settled thread height (px) — the spring's target once it lands. */
async function expectThreadHeight(target: number): Promise<void> {
  await waitFor(
    () => {
      const basis = parseFloat(thread().style.flexBasis);
      expect(Math.abs(basis - target)).toBeLessThanOrEqual(1.5);
    },
    { timeout: 4000 },
  );
}

describe("free-rest release bands + detent magnetism (matrix: FREE / slow drag rows)", () => {
  it("rests FREE under half (OPEN_UNDER_HALF) and a flick down then lands INPUT", async () => {
    render(<ChatOverlay controller={makeController()} />);
    await slowPullUpBy(150); // gap between 64 and half−64
    expect(chatState()).toBe("OPEN_UNDER_HALF");
    expect(variant()).toBe("open");
    expect(detent()).toBe("half"); // label folds sub-half free rests into half
    await expectThreadHeight(150);
    // Matrix: flick down at/below half → INPUT.
    flick(grabber(), 300, 420);
    expect(chatState()).toBe("INPUT");
    expect(variant()).toBe("closed");
  });

  it("rests FREE above half and a flick down steps to HALF FIRST, then INPUT", async () => {
    render(<ChatOverlay controller={makeController()} />);
    await slowPullUpBy(HALF_H + 150); // 503: gap between half+64 (417) and full−64 (632)
    expect(chatState()).toBe("OPEN_HALF_OR_OVER");
    expect(maximized()).toBeNull();
    await expectThreadHeight(HALF_H + 150);
    // Matrix: a free rest above half steps DOWN to HALF first — never skips
    // straight to INPUT.
    flick(grabber(), 300, 420);
    expect(detent()).toBe("half");
    expect(variant()).toBe("open");
    await expectThreadHeight(HALF_H);
    flick(grabber(), 300, 420);
    expect(chatState()).toBe("INPUT");
  });

  it("snaps to HALF when released just INSIDE the ±64 magnet band", async () => {
    render(<ChatOverlay controller={makeController()} />);
    await slowPullUpBy(HALF_H + MAGNET - 4); // 413: inside the magnet band
    expect(detent()).toBe("half");
    // The magnet SNAPPED the height to the detent — not a free rest at 413.
    await expectThreadHeight(HALF_H);
  });

  it("rests FREE when released just OUTSIDE the ±64 magnet band", async () => {
    render(<ChatOverlay controller={makeController()} />);
    await slowPullUpBy(HALF_H + MAGNET + 6); // 423: just outside → keeps its height
    expect(chatState()).toBe("OPEN_HALF_OR_OVER");
    await expectThreadHeight(HALF_H + MAGNET + 6);
  });

  it("collapses to INPUT when released within 64px of the bottom (no free sliver)", async () => {
    render(<ChatOverlay controller={makeController()} />);
    await slowPullUpBy(MAGNET - 10); // 54: "not enough to see a full row"
    expect(chatState()).toBe("INPUT");
    expect(variant()).toBe("closed");
  });

  it("keeps a short canceled preview mounted until its return spring reaches INPUT", async () => {
    render(<ChatOverlay controller={makeController()} />);
    const g = grabber();
    fireEvent.pointerDown(g, { clientY: 760, pointerId: 46 });
    fireEvent.pointerMove(g, { clientY: 710, pointerId: 46 });
    await frame();
    await waitFor(() =>
      expect(screen.queryByTestId("chat-thread")).toBeTruthy(),
    );

    fireEvent.pointerCancel(g, { clientY: 710, pointerId: 46 });

    // Pointer termination must not remove the moving body. The return spring
    // remains visible, then the collapsed-state listener unmounts it at rest.
    expect(thread()).toBeTruthy();
    await waitFor(
      () => expect(screen.queryByTestId("chat-thread")).toBeNull(),
      {
        timeout: 4000,
      },
    );
  });

  it("snaps to FULL when released within 64px of the top", async () => {
    render(<ChatOverlay controller={makeController()} />);
    // 640 travel lands in the full magnet band (≥ 632) without crossing the
    // 80%-viewport long-haul mark only if 640 < 614 is false — long-haul WOULD
    // maximize; the matrix gives long-haul precedence, so assert that contract
    // from an OPEN start instead: open to half first, then pull the remaining
    // distance (travel 287 < long-haul) into the full band.
    openToHalf();
    await slowDrag(grabber(), [400, 240, 113]); // +287 → h = 640 ≥ full−64
    expect(detent()).toBe("full");
    expect(maximized()).toBeNull();
    await expectThreadHeight(INSET_FULL_H);
  });
});

describe("bottom-band split: INPUT vs PILL (matrix: HALF slow-drag row)", () => {
  it("a slow drag from HALF released near the bottom (no overshoot) lands INPUT, not PILL", async () => {
    render(<ChatOverlay controller={makeController()} />);
    openToHalf();
    // Down by half−20 → h = 20 ≤ 64; started at half (≤ half+64), never past
    // the bottom → INPUT.
    await slowDrag(grabber(), [200, 360, 533]);
    expect(chatState()).toBe("INPUT");
    expect(detent()).toBe("collapsed");
  });

  it("a slow drag from HALF carried ≥40px PAST the bottom lands PILL", async () => {
    render(<ChatOverlay controller={makeController()} />);
    openToHalf();
    // Down by half+45 → cont −45 (past the 40px overshoot) → PILL.
    await slowDrag(grabber(), [200, 360, 520, 598]);
    // The mid-drag commit flips state on React's schedule — await the flush.
    await waitFor(() => expect(detent()).toBe("pill"));
    expect(chatState()).toBe("CLOSED");
  });
});

describe("pill-start mid-band releases (matrix: PILL held-drag row)", () => {
  function collapseToPillFirst(): void {
    flick(grabber(), 600, 700); // INPUT → PILL
    expect(detent()).toBe("pill");
  }

  it("a slow pill drag released in the half magnet band lands HALF", async () => {
    render(<ChatOverlay controller={makeController()} />);
    collapseToPillFirst();
    const pill = screen.getByTestId("chat-pill");
    // Travel = 120 (pill→input morph) + halfH − 10 → h lands inside the band.
    const travel = 120 + HALF_H - 10;
    const ys: number[] = [760];
    let t = 0;
    while (t < travel) {
      t = Math.min(travel, t + 160);
      ys.push(760 - t);
    }
    await slowDrag(pill, ys);
    expect(detent()).toBe("half");
    expect(variant()).toBe("open");
    await expectThreadHeight(HALF_H);
  });

  it("a slow pill drag released in the free gap rests FREE (pill → input → chat continuum)", async () => {
    render(<ChatOverlay controller={makeController()} />);
    collapseToPillFirst();
    const pill = screen.getByTestId("chat-pill");
    const freeTarget = HALF_H + 100; // 453: inside the upper free gap
    const travel = 120 + freeTarget;
    const ys: number[] = [760];
    let t = 0;
    while (t < travel) {
      t = Math.min(travel, t + 160);
      ys.push(760 - t);
    }
    await slowDrag(pill, ys);
    expect(chatState()).toBe("OPEN_HALF_OR_OVER");
    expect(maximized()).toBeNull();
    await expectThreadHeight(freeTarget);
  });
});

describe("restore-drag release bands (matrix: MAXIMIZED pull-down row)", () => {
  it("a slow restore pull released near HALF lands the HALF detent", async () => {
    render(<ChatOverlay controller={makeController()} />);
    bigPullUp();
    const zone = screen.getByTestId("chat-maximize-restore-zone");
    // Maximized rests at the full-bleed ceiling (VIEWPORT_H). Down-travel to
    // land inside the half magnet band.
    const dist = VIEWPORT_H - HALF_H;
    const ys: number[] = [20];
    let t = 0;
    while (t < dist) {
      t = Math.min(dist, t + 160);
      ys.push(20 + t);
    }
    await slowDrag(zone, ys);
    expect(maximized()).toBeNull();
    expect(variant()).toBe("open");
    expect(detent()).toBe("half");
    await expectThreadHeight(HALF_H);
  });

  it("a slow restore pull released in a gap rests FREE (no surprise FULL snap, no collapse)", async () => {
    render(<ChatOverlay controller={makeController()} />);
    bigPullUp();
    const zone = screen.getByTestId("chat-maximize-restore-zone");
    const freeTarget = HALF_H + 130; // 483: gap between half+64 and full−64
    const dist = VIEWPORT_H - freeTarget;
    const ys: number[] = [20];
    let t = 0;
    while (t < dist) {
      t = Math.min(dist, t + 160);
      ys.push(20 + t);
    }
    await slowDrag(zone, ys);
    expect(maximized()).toBeNull();
    expect(variant()).toBe("open");
    expect(chatState()).toBe("OPEN_HALF_OR_OVER");
    await expectThreadHeight(freeTarget);
  });

  it("a TAP on the restore strip stays MAXIMIZED (only a drag exits)", () => {
    render(<ChatOverlay controller={makeController()} />);
    bigPullUp();
    const zone = screen.getByTestId("chat-maximize-restore-zone");
    fireEvent.pointerDown(zone, { clientY: 30, pointerId: 45 });
    fireEvent.pointerUp(zone, { clientY: 30, pointerId: 45 });
    expect(maximized()).toBe("true");
    expect(chatState()).toBe("MAXIMIZED");
  });
});

describe("no lingering state across consecutive gestures", () => {
  it("after a restore to a free rest, the NEXT flick up lands FULL — never re-maximizes from the stale peak", async () => {
    render(<ChatOverlay controller={makeController()} />);
    bigPullUp();
    const zone = screen.getByTestId("chat-maximize-restore-zone");
    const freeTarget = HALF_H + 130;
    const dist = VIEWPORT_H - freeTarget;
    const ys: number[] = [20];
    let t = 0;
    while (t < dist) {
      t = Math.min(dist, t + 160);
      ys.push(20 + t);
    }
    await slowDrag(zone, ys);
    expect(maximized()).toBeNull();
    // A fresh short flick up must step to FULL — the previous gesture's
    // maximize peak is that gesture's state, not this one's.
    flick(grabber(), 400, 340);
    await frame();
    expect(detent()).toBe("full");
    expect(maximized()).toBeNull();
  });

  it("a maximize → Escape → reopen lands HALF with no residual full-bleed", () => {
    render(<ChatOverlay controller={makeController()} />);
    bigPullUp();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(variant()).toBe("closed");
    expect(maximized()).toBeNull();
    // Reopen: a plain tap must land the ordinary HALF detent, inset.
    openToHalf();
    expect(maximized()).toBeNull();
    expect(chatState()).toBe("OPEN_HALF_OR_OVER");
  });

  it("an abandoned over-pull (reversed below FULL) releases where the finger left it — never re-maximizing", async () => {
    render(<ChatOverlay controller={makeController()} />);
    openToHalf();
    const g = grabber();
    // Up into the over-pull zone, then reverse back to a mid height, slow.
    await slowDrag(g, [700, 540, 380, 220, 60, -20, 200, 320]);
    // Released well below FULL after abandoning the maximize: must not commit
    // full-bleed on release.
    expect(maximized()).toBeNull();
    expect(variant()).toBe("open");
  });
});

describe("maximize commit hysteresis", () => {
  it("pointer jitter at the commit threshold cannot flap the maximize on/off", async () => {
    const impacts: string[] = [];
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        Haptics: { impact: (o: { style: string }) => impacts.push(o.style) },
      },
    };
    render(<ChatOverlay controller={makeController()} />);
    const g = grabber();
    // Hold a drag into the mid-drag maximize commit zone (long-haul + over-pull),
    // one delivered frame per move so the commit is observed while held.
    fireEvent.pointerDown(g, { clientY: 760, pointerId: 46 });
    await frame();
    fireEvent.pointerMove(g, { clientY: 400, pointerId: 46 });
    await frame();
    fireEvent.pointerMove(g, { clientY: 28, pointerId: 46 });
    await frame();
    // The commit's setState lands on React's own schedule (the drag runs in a
    // rAF callback); the HAPTIC fires synchronously in the commit itself, so
    // the flap detection below is timing-proof.
    await waitFor(() => expect(maximized()).toBe("true"));
    const commitHaptics = impacts.length;
    // ±6px jitter around the committed point must stay inside the release band
    // and hold the state steady.
    for (const y of [34, 22, 32, 24, 30, 26]) {
      fireEvent.pointerMove(g, { clientY: y, pointerId: 46 });
      await frame();
      expect(maximized()).toBe("true");
    }
    // No extra haptics fired by the jitter (a re-commit or an un-max→re-commit
    // flap would each haptic again — one per real state change only).
    expect(impacts.length).toBe(commitHaptics);
    fireEvent.pointerUp(g, { clientY: 26, pointerId: 46 });
    await waitFor(() => expect(maximized()).toBe("true"));
    expect(chatState()).toBe("MAXIMIZED");
  });
});

describe("one haptic per detent change; none sub-threshold (matrix invariant)", () => {
  function armHaptics(): string[] {
    const impacts: string[] = [];
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        Haptics: { impact: (o: { style: string }) => impacts.push(o.style) },
      },
    };
    return impacts;
  }

  it("a grabber tap open fires exactly one haptic", () => {
    const impacts = armHaptics();
    render(<ChatOverlay controller={makeController()} />);
    openToHalf();
    expect(impacts.length).toBe(1);
  });

  it("a sub-threshold nudge fires none", async () => {
    const impacts = armHaptics();
    render(<ChatOverlay controller={makeController()} />);
    await slowDrag(grabber(), [420, 440]); // 20px drift down — springs back
    expect(chatState()).toBe("INPUT");
    expect(impacts.length).toBe(0);
  });

  it("a drag out the bottom haptics ONCE (mid-drag pill commit; the release settles silently)", async () => {
    const impacts = armHaptics();
    render(<ChatOverlay controller={makeController()} />);
    openToHalf(); // 1 haptic
    await slowDrag(grabber(), [200, 360, 520, 598]); // past the bottom → PILL
    await waitFor(() => expect(detent()).toBe("pill"));
    expect(impacts.length).toBe(2); // open + the single pill commit
  });

  it("each detent step of a flick sequence fires exactly one haptic", () => {
    const impacts = armHaptics();
    render(<ChatOverlay controller={makeController()} />);
    openToHalf(); // 1
    flick(grabber(), 400, 300); // half → full: 2
    expect(detent()).toBe("full");
    flick(grabber(), 300, 420); // full → half: 3
    expect(detent()).toBe("half");
    expect(impacts.length).toBe(3);
  });
});

describe("thread-less grabber tap (matrix: INPUT tap row)", () => {
  it("focuses the composer instead of opening an empty sheet", async () => {
    render(
      <ChatOverlay controller={makeController({ messages: [] } as never)} />,
    );
    const input = screen.getByLabelText("message");
    fireEvent.pointerDown(grabber(), { clientY: 420, pointerId: 47 });
    fireEvent.pointerUp(grabber(), { clientY: 420, pointerId: 47 });
    await frame();
    expect(variant()).toBe("closed");
    expect(document.activeElement).toBe(input);
  });
});

describe("pill capsule horizontal swipe (matrix: PILL swipe row)", () => {
  it("is a consumed no-op — stays PILL, never opens", () => {
    render(<ChatOverlay controller={makeController()} />);
    flick(grabber(), 600, 700); // INPUT → PILL
    expect(detent()).toBe("pill");
    const pill = screen.getByTestId("chat-pill");
    fireEvent.pointerDown(pill, { clientX: 260, clientY: 760, pointerId: 48 });
    fireEvent.pointerMove(pill, { clientX: 110, clientY: 756, pointerId: 48 });
    fireEvent.pointerUp(pill, { clientX: 110, clientY: 756, pointerId: 48 });
    expect(detent()).toBe("pill");
    expect(chatState()).toBe("CLOSED");
  });
});
