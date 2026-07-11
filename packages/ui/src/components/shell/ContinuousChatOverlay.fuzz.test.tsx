// @vitest-environment jsdom

// Adversarial + fuzz coverage for the floating chat (ContinuousChatOverlay).
//
// The overlay is a small state machine: ONE `mode` ∈ {pill, input, half, full}
// with `maximized` and a free-drag rest height as orthogonal overrides. Every
// observable surface (data-detent / data-variant / data-chat-state / data-
// maximized, the pill's interactivity, the composer's `inert`) is DERIVED from
// that machine, so the impossible "open but not open" / "pilled and full" combos
// must never occur — no matter how the user (or a malformed device event stream)
// pokes at it.
//
// This suite drives the component through:
//   • every reachable state × every action (the state matrix),
//   • out-of-state / nonsensical actions (escape while collapsed, backdrop tap
//     while closed, maximize with no header, send with no draft, …),
//   • multi-press storms (the same control hammered N times),
//   • random pointer storms in arbitrary screen areas,
//   • adversarial malformed pointer streams (up without down, double-down,
//     cancel / lost-capture mid-drag, interleaved pointer ids),
//   • seeded random action sequences (reproducible fuzzing),
// and after EVERY step asserts the full invariant set. A single broken/stuck
// state anywhere fails the run with the exact step that produced it.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../api/client", () => ({
  client: { fetch: vi.fn().mockRejectedValue(new Error("no api in test")) },
}));
vi.mock("../../utils/clipboard", () => ({
  copyTextToClipboard: vi.fn().mockResolvedValue(undefined),
}));

import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
import type { ShellController } from "./useShellController";

beforeAll(() => {
  // jsdom gaps the overlay reaches for.
  Element.prototype.scrollIntoView = vi.fn();
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = vi.fn();
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = vi.fn();
  }
  // Drive REDUCED MOTION so framer-motion writes motion values synchronously
  // (no RAF in jsdom). That makes derived-from-motion-value surfaces — chiefly
  // `headerVisible`, which gates the maximize button — deterministic, so the
  // MAXIMIZED state is reachable in a unit test. State logic is identical with
  // or without reduced motion; only the tween timing differs.
  window.matchMedia = ((query: string) => ({
    matches: /reduce/i.test(query),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(cleanup);

function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    messages: [
      { id: "a", role: "assistant", content: "hello there", createdAt: 1 },
      { id: "b", role: "user", content: "hi back", createdAt: 2 },
    ],
    canSend: true,
    responding: false,
    turnStatus: null,
    recording: false,
    transcript: "",
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    clearConversation: vi.fn(),
    ...overrides,
  } as unknown as ShellController;
}

// ── DOM accessors ────────────────────────────────────────────────────────────
const sheet = () => screen.getByTestId("chat-sheet");
const grabber = () => screen.queryByTestId("chat-sheet-grabber");
const pill = () => screen.getByTestId("chat-pill");
const input = () =>
  screen.getByTestId("chat-composer-textarea") as HTMLTextAreaElement;
const backdrop = () => screen.getByTestId("chat-sheet-backdrop");
const content = () => screen.getByTestId("chat-content");
const detentOf = () => sheet().getAttribute("data-detent");
const variantOf = () => sheet().getAttribute("data-variant");
const chatStateOf = () => sheet().getAttribute("data-chat-state");

const DETENTS = ["pill", "collapsed", "half", "full"];
const CHAT_STATES = [
  "CLOSED",
  "INPUT",
  "OPEN_UNDER_HALF",
  "OPEN_HALF_OR_OVER",
  "MAXIMIZED",
];

// ── The invariant set — the heart of the suite ───────────────────────────────
// Run after EVERY action. If any of these fail the chat is in an impossible or
// stuck state.
function assertInvariants(ctx: string): void {
  const where = `[${ctx}]`;

  // Exactly one of each singleton surface — no leaked/duplicated panels.
  expect(
    screen.getAllByTestId("chat-sheet"),
    `${where} one sheet`,
  ).toHaveLength(1);
  expect(screen.getAllByTestId("chat-pill"), `${where} one pill`).toHaveLength(
    1,
  );
  expect(
    screen.getAllByTestId("chat-composer-textarea"),
    `${where} one composer`,
  ).toHaveLength(1);

  const detent = detentOf();
  const variant = variantOf();
  const chatState = chatStateOf();
  const maximized = sheet().getAttribute("data-maximized");

  expect(DETENTS, `${where} detent=${detent}`).toContain(detent);
  expect(CHAT_STATES, `${where} chatState=${chatState}`).toContain(chatState);

  // open ⟺ a thread detent. closed ⟺ pill or the input peek.
  if (detent === "half" || detent === "full") {
    expect(variant, `${where} open detent ⇒ variant open`).toBe("open");
  } else {
    expect(variant, `${where} closed detent ⇒ variant closed`).toBe("closed");
  }

  // detent ⟺ chat-state (the enum and the height ordinal can never disagree).
  if (detent === "pill") {
    expect(chatState, `${where} pill ⇒ CLOSED`).toBe("CLOSED");
  } else if (detent === "collapsed") {
    expect(chatState, `${where} collapsed ⇒ INPUT`).toBe("INPUT");
  } else {
    expect(
      ["OPEN_UNDER_HALF", "OPEN_HALF_OR_OVER", "MAXIMIZED"],
      `${where} open ⇒ open chat-state (${chatState})`,
    ).toContain(chatState);
  }

  // Maximized (full-bleed) is ONLY ever the full detent.
  if (maximized === "true") {
    expect(detent, `${where} maximized ⇒ full`).toBe("full");
    expect(chatState, `${where} maximized ⇒ MAXIMIZED`).toBe("MAXIMIZED");
  }

  // The pill capsule owns the gesture (and the composer is sealed away) IFF
  // pilled — otherwise taps must fall through to the composer and it must be
  // reachable for input.
  const pilled = detent === "pill";
  if (pilled) {
    expect(pill().className, `${where} pill interactive`).toContain(
      "pointer-events-auto",
    );
    expect(content().hasAttribute("inert"), `${where} pilled ⇒ inert`).toBe(
      true,
    );
  } else {
    expect(pill().className, `${where} pill inert`).toContain(
      "pointer-events-none",
    );
    expect(content().hasAttribute("inert"), `${where} not pilled ⇒ live`).toBe(
      false,
    );
  }

  // The grabber is absent only at full-bleed; when present its open flag tracks
  // the sheet.
  const g = grabber();
  if (g) {
    const open = variant === "open";
    expect(g.getAttribute("data-open"), `${where} grabber open flag`).toBe(
      open ? "true" : "false",
    );
  } else {
    expect(maximized, `${where} grabber absent ⇒ maximized`).toBe("true");
  }

  // The overlay root is always non-blocking (controls behind it stay live).
  const root = screen.getByTestId("continuous-chat-overlay");
  expect(root.className, `${where} overlay passes through`).toContain(
    "pointer-events-none",
  );
}

// ── Gesture primitives ───────────────────────────────────────────────────────
// In jsdom performance.now barely advances, so any move reads as a high-velocity
// FLICK (the dominant real path). `slowDrag` mocks the clock to exercise the
// deliberate-drag / free-rest path.
function tap(el: Element, y = 300): void {
  fireEvent.pointerDown(el, { clientY: y, pointerId: 1 });
  fireEvent.pointerUp(el, { clientY: y, pointerId: 1 });
}
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
function slowDrag(el: Element, fromY: number, toY: number): void {
  const now = vi.spyOn(performance, "now");
  now.mockReturnValue(0);
  fireEvent.pointerDown(el, { clientY: fromY, pointerId: 1 });
  fireEvent.pointerMove(el, { clientY: toY, pointerId: 1 });
  now.mockReturnValue(800); // 800ms elapsed ⇒ low velocity ⇒ settle/free-rest
  fireEvent.pointerUp(el, { clientY: toY, pointerId: 1 });
  now.mockRestore();
}
const flickUp = (el: Element) => flick(el, 420, 400);
const flickDown = (el: Element) => flick(el, 200, 220);
// A big upward over-pull of the grabber — far past the FULL detent — which the
// pull-to-maximize path (#13531) commits to edge-to-edge full-bleed. Maximize is
// a gesture now, not a button.
function bigPullUp(el: Element): void {
  const now = vi.spyOn(performance, "now");
  now.mockReturnValue(0);
  fireEvent.pointerDown(el, { clientY: 760, pointerId: 1 });
  now.mockReturnValue(200);
  fireEvent.pointerMove(el, { clientY: 400, pointerId: 1 });
  now.mockReturnValue(400);
  fireEvent.pointerMove(el, { clientY: 40, pointerId: 1 });
  now.mockReturnValue(800); // slow ⇒ settle/free-rest path (not a flick)
  fireEvent.pointerMove(el, { clientY: 0, pointerId: 1 });
  fireEvent.pointerUp(el, { clientY: 0, pointerId: 1 });
  now.mockRestore();
}
// A downward pull that STARTS in the maximized top-20% restore zone — exits
// full-bleed back to the inset FULL-detent overlay (#13531).
function pullDownRestoreZone(): void {
  const zone = screen.getByTestId("chat-maximize-restore-zone");
  const now = vi.spyOn(performance, "now");
  now.mockReturnValue(0);
  fireEvent.pointerDown(zone, { clientY: 20, pointerId: 1 });
  now.mockReturnValue(200);
  fireEvent.pointerMove(zone, { clientY: 200, pointerId: 1 });
  now.mockReturnValue(800);
  fireEvent.pointerUp(zone, { clientY: 320, pointerId: 1 });
  now.mockRestore();
}
const focusReal = () => act(() => input().focus());
const blurReal = () => act(() => input().blur());

// Navigate from the fresh (collapsed/input) render to a target state.
function gotoPill(): void {
  flickDown(grabber() as Element);
  expect(detentOf()).toBe("pill");
}
function gotoHalf(): void {
  flickUp(grabber() as Element);
  expect(detentOf()).toBe("half");
}
function gotoFull(): void {
  gotoHalf();
  flickUp(grabber() as Element);
  expect(detentOf()).toBe("full");
}
function gotoMaximized(): void {
  // Maximize is a big upward over-pull now (#13531), not a header button.
  bigPullUp(grabber() as Element);
  expect(detentOf()).toBe("full");
  expect(sheet().getAttribute("data-maximized")).toBe("true");
}

describe("ContinuousChatOverlay — reachable states", () => {
  it("reaches every named state and each satisfies the invariants", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    assertInvariants("fresh");
    expect(detentOf()).toBe("collapsed"); // INPUT peek is the resting state

    gotoPill();
    assertInvariants("pill");

    cleanup();
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoHalf();
    assertInvariants("half");

    cleanup();
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoFull();
    assertInvariants("full");

    cleanup();
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoMaximized();
    assertInvariants("maximized");

    // Free-rest above half (a deliberate slow drag that lands between detents).
    cleanup();
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoHalf();
    slowDrag(grabber() as Element, 300, 150); // pull up ~150px into the gap
    assertInvariants("free-rest");
    expect(detentOf()).toBe("half"); // free-rest below full still labels half
  });
});

describe("ContinuousChatOverlay — state × action matrix", () => {
  // Every action, applied from every reachable resting state, must leave the
  // chat in a valid state (and never throw). Where the transition is fully
  // determined we also assert the destination.
  const setups: Array<{ name: string; go: () => void }> = [
    { name: "input", go: () => {} },
    { name: "pill", go: gotoPill },
    { name: "half", go: gotoHalf },
    { name: "full", go: gotoFull },
    { name: "maximized", go: gotoMaximized },
  ];

  const actions: Array<{ name: string; run: () => void }> = [
    {
      name: "tap-grabber",
      run: () => grabber() && tap(grabber() as Element, 180),
    },
    {
      name: "flick-up-grabber",
      run: () => grabber() && flickUp(grabber() as Element),
    },
    {
      name: "flick-down-grabber",
      run: () => grabber() && flickDown(grabber() as Element),
    },
    { name: "tap-pill", run: () => tap(pill(), 400) },
    { name: "flick-up-pill", run: () => flick(pill(), 420, 400) },
    { name: "focus-input", run: focusReal },
    { name: "blur-input", run: blurReal },
    { name: "fire-focus", run: () => fireEvent.focus(input()) },
    {
      name: "type",
      run: () => fireEvent.change(input(), { target: { value: "x" } }),
    },
    {
      name: "clear",
      run: () => fireEvent.change(input(), { target: { value: "" } }),
    },
    { name: "enter", run: () => fireEvent.keyDown(input(), { key: "Enter" }) },
    {
      name: "escape",
      run: () => fireEvent.keyDown(input(), { key: "Escape" }),
    },
    { name: "click-backdrop", run: () => fireEvent.click(backdrop()) },
    {
      name: "pointerdown-backdrop",
      run: () => fireEvent.pointerDown(backdrop()),
    },
    {
      name: "pointerdown-body",
      run: () => fireEvent.pointerDown(document.body),
    },
    {
      // Maximize is a big upward over-pull of the grabber now (#13531). When the
      // grabber is absent (already maximized), it's a no-op — the matrix just
      // proves the state stays valid.
      name: "maximize",
      run: () => {
        const g = grabber();
        if (g) bigPullUp(g);
      },
    },
    {
      // Restore-from-maximized: a downward pull in the top-20% zone (#13531).
      // No-op when not maximized (the zone is unmounted).
      name: "restore-zone-pull-down",
      run: () => {
        if (screen.queryByTestId("chat-maximize-restore-zone")) {
          pullDownRestoreZone();
        }
      },
    },
  ];

  for (const setup of setups) {
    for (const action of actions) {
      it(`${setup.name} + ${action.name} stays valid`, () => {
        render(<ContinuousChatOverlay controller={makeController()} />);
        setup.go();
        assertInvariants(`${setup.name}:before:${action.name}`);
        action.run();
        assertInvariants(`${setup.name}:after:${action.name}`);
        // The composer is always still typeable afterwards once we leave pill.
        if (detentOf() !== "pill") {
          fireEvent.change(input(), { target: { value: "after" } });
          expect(input().value).toBe("after");
        }
      });
    }
  }
});

describe("ContinuousChatOverlay — out-of-state / nonsensical actions are no-ops", () => {
  it("Escape while collapsed does not open or break the chat", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(detentOf()).toBe("collapsed");
    assertInvariants("escape-collapsed");
  });

  it("backdrop click while collapsed is inert (no handler attached)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(backdrop().getAttribute("data-active")).toBe("false");
    fireEvent.click(backdrop());
    expect(detentOf()).toBe("collapsed");
    assertInvariants("backdrop-collapsed");
  });

  it("Enter with an empty draft never sends", () => {
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(controller.send).not.toHaveBeenCalled();
    assertInvariants("empty-enter");
  });

  it("flick DOWN while already pilled stays pilled (lowest detent)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoPill();
    flickDown(pill());
    expect(detentOf()).toBe("pill");
    assertInvariants("pill-flickdown");
  });

  it("flick UP while already at full stays full (highest detent)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoFull();
    flickUp(grabber() as Element);
    expect(detentOf()).toBe("full");
    assertInvariants("full-flickup");
  });

  it("typing while pilled (synthetic, bypasses inert) never lands in a broken state", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoPill();
    fireEvent.change(input(), { target: { value: "ghost" } });
    assertInvariants("type-while-pilled");
  });
});

describe("ContinuousChatOverlay — multi-press storms", () => {
  it("hammering the grabber tap 40× ends in a valid state", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    for (let i = 0; i < 40; i++) {
      const g = grabber();
      if (g) tap(g, 180);
      assertInvariants(`grabber-spam-${i}`);
    }
  });

  it("hammering pill flick-up then grabber flick-down 30× never sticks", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    for (let i = 0; i < 30; i++) {
      const g = grabber();
      if (g) flickDown(g); // → pill
      assertInvariants(`down-${i}`);
      if (detentOf() === "pill") flick(pill(), 420, 400); // → back open
      assertInvariants(`up-${i}`);
    }
    // Always recoverable to a usable composer.
    if (detentOf() === "pill") flick(pill(), 420, 400);
    fireEvent.change(input(), { target: { value: "recovered" } });
    expect(input().value).toBe("recovered");
  });

  it("focus/blur storm 50× leaves the composer reachable", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    for (let i = 0; i < 50; i++) {
      focusReal();
      assertInvariants(`focus-${i}`);
      blurReal();
      assertInvariants(`blur-${i}`);
    }
  }, 15_000);

  it("Escape spam 25× while toggling open never throws or sticks open", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    for (let i = 0; i < 25; i++) {
      fireEvent.focus(input()); // open
      fireEvent.keyDown(input(), { key: "Escape" }); // close
      assertInvariants(`escape-spam-${i}`);
    }
    expect(detentOf()).toBe("collapsed");
  });

  it("pull-up-to-maximize then a restore-zone pull-down drops full-bleed and rests open (not a collapse)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    // Big over-pull maximizes.
    gotoMaximized();
    expect(sheet().getAttribute("data-maximized")).toBe("true");
    assertInvariants("maximized");
    // A downward pull in the restore zone drops full-bleed and rests at the
    // RELEASED height (live restore, not a fixed snap): this ~300px pull lands
    // un-maximized but still OPEN — the key contract is "not a full collapse".
    pullDownRestoreZone();
    expect(sheet().getAttribute("data-maximized")).not.toBe("true");
    expect(sheet().getAttribute("data-variant")).toBe("open");
    assertInvariants("un-maximized");
  });
});

describe("ContinuousChatOverlay — adversarial malformed pointer streams", () => {
  it("pointerUp with no prior pointerDown is a no-op", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.pointerUp(grabber() as Element, { clientY: 300, pointerId: 9 });
    expect(detentOf()).toBe("collapsed");
    assertInvariants("orphan-up");
  });

  it("double pointerDown then a single pointerUp does not double-fire", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const g = grabber() as Element;
    fireEvent.pointerDown(g, { clientY: 420, pointerId: 1 });
    fireEvent.pointerDown(g, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(g, { clientY: 400, pointerId: 1 });
    fireEvent.pointerUp(g, { clientY: 400, pointerId: 1 });
    assertInvariants("double-down");
  });

  it("pointerCancel mid-drag settles cleanly (no stranded morph)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const g = grabber() as Element;
    fireEvent.pointerDown(g, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(g, { clientY: 300, pointerId: 1 });
    fireEvent.pointerCancel(g, { clientY: 300, pointerId: 1 });
    assertInvariants("cancel-mid-drag");
  });

  it("lostPointerCapture mid-drag settles cleanly (rotation case)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const g = grabber() as Element;
    fireEvent.pointerDown(g, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(g, { clientY: 360, pointerId: 1 });
    fireEvent.lostPointerCapture(g, { clientY: 360, pointerId: 1 });
    assertInvariants("lost-capture");
  });

  it("interleaved pointer ids do not corrupt the gesture", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const g = grabber() as Element;
    fireEvent.pointerDown(g, { clientY: 420, pointerId: 1 });
    fireEvent.pointerMove(g, { clientY: 410, pointerId: 2 });
    fireEvent.pointerUp(g, { clientY: 405, pointerId: 7 });
    assertInvariants("interleaved-ids");
  });

  it("a flood of random pointer events on random targets never breaks state", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    const targets = () => [
      grabber(),
      pill(),
      backdrop(),
      content(),
      screen.getByTestId("continuous-chat-overlay"),
      document.body,
    ];
    const rng = mulberry32(0xc0ffee);
    const kinds = [
      "pointerDown",
      "pointerUp",
      "pointerMove",
      "pointerCancel",
      "lostPointerCapture",
    ] as const;
    for (let i = 0; i < 300; i++) {
      const pool = targets().filter(Boolean) as Element[];
      const target = pool[Math.floor(rng() * pool.length)];
      const kind = kinds[Math.floor(rng() * kinds.length)];
      const y = Math.floor(rng() * 700);
      (fireEvent[kind] as (t: Element, init?: object) => void)(target, {
        clientY: y,
        pointerId: 1 + Math.floor(rng() * 3),
      });
      assertInvariants(`pointer-flood-${i}`);
    }
  });
});

// ── Seeded random fuzz over the whole action set ─────────────────────────────
function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ContinuousChatOverlay — seeded random fuzz", () => {
  const fuzzActions: Array<(rng: () => number) => void> = [
    () => grabber() && tap(grabber() as Element, 180),
    () => grabber() && flickUp(grabber() as Element),
    () => grabber() && flickDown(grabber() as Element),
    () => grabber() && slowDrag(grabber() as Element, 300, 150),
    () => grabber() && slowDrag(grabber() as Element, 200, 320),
    () => tap(pill(), 400),
    () => flick(pill(), 420, 400),
    focusReal,
    blurReal,
    () => fireEvent.focus(input()),
    (rng) =>
      fireEvent.change(input(), {
        target: { value: randomDraft(rng) },
      }),
    () => fireEvent.change(input(), { target: { value: "" } }),
    () => fireEvent.keyDown(input(), { key: "Enter" }),
    () => fireEvent.keyDown(input(), { key: "Escape" }),
    () => fireEvent.click(backdrop()),
    () => fireEvent.pointerDown(backdrop()),
    () => fireEvent.pointerDown(document.body),
    // Maximize is a big upward over-pull now (#13531); restore is a top-20%
    // pull-down. Both no-op when their surface is absent.
    () => {
      const g = grabber();
      if (g) bigPullUp(g);
    },
    () => {
      if (screen.queryByTestId("chat-maximize-restore-zone")) {
        pullDownRestoreZone();
      }
    },
  ];

  function randomDraft(rng: () => number): string {
    const r = rng();
    if (r < 0.15) return "";
    if (r < 0.3) return "   ";
    if (r < 0.45) return "/settings";
    if (r < 0.6) return "a".repeat(1 + Math.floor(rng() * 200));
    // Keep it seed-deterministic (no Math.random) so a failing seed reproduces.
    return rng()
      .toString(36)
      .slice(2, 2 + Math.floor(rng() * 12));
  }

  // A handful of seeds, each a long random walk; the invariant set is checked
  // after every single step so any seed that finds a broken state pinpoints it.
  for (const seed of [1, 42, 1337, 0xbeef, 271828]) {
    it(`survives a 60-step random walk (seed ${seed})`, () => {
      render(<ContinuousChatOverlay controller={makeController()} />);
      const rng = mulberry32(seed);
      for (let step = 0; step < 60; step++) {
        const idx = Math.floor(rng() * fuzzActions.length);
        fuzzActions[idx](rng);
        assertInvariants(`seed=${seed} step=${step} action=${idx}`);
      }
      // Whatever the walk did, the chat must remain RECOVERABLE: bring it to a
      // usable composer and send a message end-to-end.
      const controller = recover();
      expect(controller).toBeTruthy();
    });
  }

  // Drive the chat back to a state where a message can be typed + sent.
  function recover(): boolean {
    // Out of the pill first.
    if (detentOf() === "pill") flick(pill(), 420, 400);
    if (detentOf() === "pill") tap(pill(), 400);
    expect(detentOf()).not.toBe("pill");
    fireEvent.change(input(), { target: { value: "final message" } });
    expect(input().value).toBe("final message");
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(input().value).toBe("");
    return true;
  }
});

// ── The two reported bugs, pinned ────────────────────────────────────────────
describe("ContinuousChatOverlay — bug (a): a single pill tap opens to half", () => {
  it("ONE tap on the pill opens the chat to half (no blink-back, no second tap)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoPill();
    tap(pill(), 400); // a single tap
    expect(detentOf()).toBe("half");
    expect(variantOf()).toBe("open");
    expect(document.activeElement).toBe(input()); // keyboard raised on first tap
    assertInvariants("bug-a-single-tap");
  });

  it("repeated open/collapse via the pill always reaches half on the very next tap", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    for (let i = 0; i < 5; i++) {
      gotoPill();
      tap(pill(), 400);
      expect(detentOf(), `cycle ${i}`).toBe("half");
      // back to the pill for the next cycle
      flickDown(grabber() as Element);
    }
  });
});

describe("ContinuousChatOverlay — bug (b): keyboard dismiss restores prior state", () => {
  it("input → focus (auto-opens) → tap OUTSIDE → returns to the input peek", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    expect(detentOf()).toBe("collapsed");
    focusReal(); // keyboard up; auto-expands to half
    expect(detentOf()).toBe("half");
    fireEvent.pointerDown(document.body); // tap outside
    expect(detentOf()).toBe("collapsed"); // back to where we were
    expect(document.activeElement).not.toBe(input());
    assertInvariants("bug-b-input-clickout");
  });

  it("half (already open) → focus → tap OUTSIDE → STAYS open (size returns)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoHalf();
    focusReal(); // keyboard up over an already-open sheet
    expect(detentOf()).toBe("half");
    fireEvent.pointerDown(document.body);
    expect(detentOf()).toBe("half"); // open chat stays open
    expect(document.activeElement).not.toBe(input()); // keyboard dropped
    assertInvariants("bug-b-half-clickout");
  });

  it("half (already open) → focus → tap the SCRIM → STAYS open (first tap only drops keyboard)", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoHalf();
    focusReal();
    fireEvent.pointerDown(backdrop());
    fireEvent.click(backdrop());
    expect(detentOf()).toBe("half");
    assertInvariants("bug-b-half-scrim");
  });

  it("input → focus → tap the SCRIM → collapses back to the input peek", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    focusReal(); // auto-opens to half from the input peek
    expect(detentOf()).toBe("half");
    fireEvent.pointerDown(backdrop(), {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
    });
    fireEvent.pointerUp(backdrop(), { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.click(backdrop());
    expect(detentOf()).toBe("collapsed");
    assertInvariants("bug-b-input-scrim");
  });

  it("a SECOND scrim tap (keyboard already down) closes an open chat", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoHalf(); // open, but not composer-focused (keyboard down)
    expect(document.activeElement).not.toBe(input());
    fireEvent.pointerDown(backdrop(), {
      clientX: 20,
      clientY: 20,
      pointerId: 1,
    });
    fireEvent.pointerUp(backdrop(), { clientX: 20, clientY: 20, pointerId: 1 });
    fireEvent.click(backdrop());
    expect(detentOf()).toBe("collapsed"); // backdrop closes when keyboard is down
    assertInvariants("bug-b-scrim-close");
  });

  it("tap the GRABBER with the keyboard up restores prior state (half stays, input collapses)", () => {
    // already-open: grabber tap drops keyboard, stays half
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoHalf();
    focusReal();
    tap(grabber() as Element, 180);
    expect(detentOf()).toBe("half");
    expect(document.activeElement).not.toBe(input());
    assertInvariants("bug-b-grabber-half");

    // auto-opened-from-input: grabber tap drops keyboard AND re-collapses
    cleanup();
    render(<ContinuousChatOverlay controller={makeController()} />);
    focusReal();
    expect(detentOf()).toBe("half");
    tap(grabber() as Element, 180);
    expect(detentOf()).toBe("collapsed");
    assertInvariants("bug-b-grabber-input");
  });

  it("pill tap → half, then dismissing the keyboard keeps the chat open at half", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    gotoPill();
    tap(pill(), 400); // opens to half + raises keyboard (bug a)
    expect(detentOf()).toBe("half");
    fireEvent.pointerDown(document.body); // dismiss keyboard
    expect(detentOf()).toBe("half"); // deliberate open survives (bug b)
    assertInvariants("bug-ab-pill-then-dismiss");
  });

  it("SENDING commits to open: tap input → send → dismiss keyboard KEEPS the chat open", () => {
    // Tap into the collapsed input (auto-opens to half, keyboard up), send a
    // message, then drop the keyboard. The conversation must stay visible — NOT
    // collapse back to the bare input peek, which would hide the chat you just
    // had. (Contrast: tapping in and dismissing WITHOUT sending re-collapses.)
    const controller = makeController();
    render(<ContinuousChatOverlay controller={controller} />);
    expect(detentOf()).toBe("collapsed");
    focusReal(); // tap into the input
    expect(detentOf()).toBe("half");
    fireEvent.change(input(), { target: { value: "hello" } });
    fireEvent.keyDown(input(), { key: "Enter" }); // send
    expect(controller.send).toHaveBeenCalled();
    tap(grabber() as Element, 180); // dismiss the keyboard
    expect(detentOf()).toBe("half"); // stays open — conversation preserved
    assertInvariants("send-commits-open");
  });
});

// ── Extended long-path adversarial fuzz (longer paths, input variety) ─────────
// A senior-QA / adversarial pass on top of the state-machine matrix above: LONG
// seeded random walks (150 steps each, 6 seeds = 900 driven interactions) that
// interleave every gesture / keyboard / backdrop action with a corpus of
// ADVERSARIAL composer inputs (empty, whitespace, 5k chars, emoji + CJK + RTL,
// markup, control chars, multiline, symbol soup). After EVERY step the full
// invariant set must hold; whenever the composer is live it must round-trip the
// exact input; and after the whole storm the sheet must recover to a usable,
// unstuck composer. Reproduces deterministically per seed.
describe("ContinuousChatOverlay — long adversarial random walk", () => {
  const ADVERSARIAL_INPUTS: readonly string[] = [
    "",
    "   ",
    "\n\n\t  ",
    "hi",
    "the quick brown fox jumps over the lazy dog",
    "a".repeat(5000),
    "😀🎉🔥 emoji · 你好世界 · مرحبا بالعالم",
    "<script>alert('xss')</script>",
    "line one\nline two\nline three",
    "```ts\nconst x = 1;\n```",
    "  padded surface  ",
    "\u001b[31mansi\u001b[0m control",
    "@#$%^&*(){}[]|\\/<>?~`",
  ];

  const walkActions: Array<() => void> = [
    () => grabber() && tap(grabber() as Element, 180),
    () => grabber() && flickUp(grabber() as Element),
    () => grabber() && flickDown(grabber() as Element),
    () => grabber() && slowDrag(grabber() as Element, 420, 200),
    () => grabber() && slowDrag(grabber() as Element, 200, 420),
    () => tap(pill(), 400),
    () => flick(pill(), 420, 400),
    focusReal,
    blurReal,
    () => fireEvent.keyDown(input(), { key: "Enter" }),
    () => fireEvent.keyDown(input(), { key: "Enter", shiftKey: true }),
    () => fireEvent.keyDown(input(), { key: "Escape" }),
    () => fireEvent.click(backdrop()),
    () => fireEvent.pointerDown(document.body),
    // Maximize/restore are pull gestures now (#13531); no clear/new-chat button.
    () => {
      const g = grabber();
      if (g) bigPullUp(g);
    },
    () => {
      if (screen.queryByTestId("chat-maximize-restore-zone")) {
        pullDownRestoreZone();
      }
    },
  ];

  for (const seed of [1, 7, 42, 101, 2718, 31337]) {
    it(`seed ${seed}: 150-step walk keeps invariants + round-trips input + recovers`, () => {
      render(<ContinuousChatOverlay controller={makeController()} />);
      let s = seed >>> 0;
      const rand = () => {
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      for (let step = 0; step < 150; step += 1) {
        if (rand() < 0.3) {
          const payload =
            ADVERSARIAL_INPUTS[Math.floor(rand() * ADVERSARIAL_INPUTS.length)];
          // The composer is live in every detent except the collapsed pill.
          if (detentOf() !== "pill") {
            fireEvent.change(input(), { target: { value: payload } });
            expect(
              input().value,
              `seed ${seed} step ${step} input round-trip`,
            ).toBe(payload);
          }
        } else {
          walkActions[Math.floor(rand() * walkActions.length)]();
        }
        assertInvariants(`seed ${seed} step ${step}`);
      }
      // No stuck state after the storm: reach a live composer and round-trip.
      if (detentOf() === "pill") tap(pill(), 400);
      focusReal();
      fireEvent.change(input(), { target: { value: "recovered" } });
      expect(input().value, `seed ${seed} recovered composer`).toBe(
        "recovered",
      );
      assertInvariants(`seed ${seed} recovered`);
    }, 15_000);
  }
});
