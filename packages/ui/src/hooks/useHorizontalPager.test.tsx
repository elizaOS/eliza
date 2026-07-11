// @vitest-environment jsdom
//
// Unit coverage for useHorizontalPager (#10717): velocity-aware momentum settle
// (a fast flick settles quicker than a slow drag over the same distance), the
// pointer edge-button surface (canPrev/canNext + goPrev/goNext one-page nav),
// and the touch/mouse capture guards. Drives REAL React pointer events through
// the hook and reads the transition the hook writes to the rail;
// performance.now is mocked to make release velocity deterministic.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRailGestureActive,
  resetRailGestureForTests,
} from "../state/rail-gesture-store";
import { runAnimationFramesImmediately } from "../testing/run-animation-frames-immediately";
import { useHorizontalPager } from "./useHorizontalPager";

let clock = 1000;

beforeEach(() => {
  clock = 1000;
  resetRailGestureForTests();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Harness({
  initialPage = 0,
  pageCount = 3,
  onPageChange,
  onRailClick,
}: {
  initialPage?: number;
  pageCount?: number;
  onPageChange?: (page: number) => void;
  onRailClick?: () => void;
}): React.JSX.Element {
  const [page, setPage] = React.useState(initialPage);
  const pager = useHorizontalPager({
    page,
    pageCount,
    onPageChange: (next) => {
      onPageChange?.(next);
      setPage(next);
    },
  });
  return (
    <div>
      <div ref={pager.viewportRef}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: test-only click sink for the committed-swipe suppression assertion */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: test-only click sink; keyboard nav is not under test here */}
        <div
          data-testid="rail"
          ref={pager.railRef}
          onPointerDown={pager.handlers.onPointerDown}
          onPointerMove={pager.handlers.onPointerMove}
          onPointerUp={pager.handlers.onPointerUp}
          onPointerCancel={pager.handlers.onPointerCancel}
          onLostPointerCapture={pager.handlers.onLostPointerCapture}
          onClickCapture={pager.handlers.onClickCapture}
          onClick={onRailClick}
        >
          {/* A child (mirrors the home notification pull-strip) whose bubbled
              lostpointercapture must NOT cancel a rail drag. */}
          <div data-testid="rail-child" />
        </div>
      </div>
      <button
        type="button"
        data-testid="prev"
        disabled={!pager.canPrev}
        onClick={pager.goPrev}
      >
        prev
      </button>
      <button
        type="button"
        data-testid="next"
        disabled={!pager.canNext}
        onClick={pager.goNext}
      >
        next
      </button>
    </div>
  );
}

function settleMsFromRail(rail: HTMLElement): number | null {
  const match = rail.style.transition.match(/transform\s+(\d+(?:\.\d+)?)ms/);
  return match ? Number(match[1]) : null;
}

/** Drive a left swipe (advance to the next page) over `elapsed` ms. */
function swipeNext(
  rail: HTMLElement,
  fromX: number,
  toX: number,
  elapsed: number,
) {
  const opts = {
    pointerId: 1,
    pointerType: "touch",
    isPrimary: true,
    clientY: 300,
  } as const;
  act(() => {
    clock = 1000;
    fireEvent.pointerDown(rail, { ...opts, clientX: fromX });
    // Commit the horizontal axis with a small first move.
    fireEvent.pointerMove(rail, { ...opts, clientX: fromX - 20 });
    fireEvent.pointerMove(rail, { ...opts, clientX: toX });
    clock = 1000 + elapsed;
    fireEvent.pointerUp(rail, { ...opts, clientX: toX });
  });
}

describe("useHorizontalPager — velocity-aware momentum settle (#10717)", () => {
  it("a fast flick settles quicker than a slow drag over the same distance", () => {
    const fastChange = vi.fn();
    const { getByTestId, unmount } = render(
      <Harness onPageChange={fastChange} />,
    );
    // dx = -700 (crosses the 50% distance threshold on the 1024px jsdom
    // viewport → advances even without flick velocity), released in 40ms.
    swipeNext(getByTestId("rail"), 800, 100, 40);
    expect(fastChange).toHaveBeenCalledWith(1);
    const fastMs = settleMsFromRail(getByTestId("rail"));
    unmount();

    const slowChange = vi.fn();
    const { getByTestId: get2 } = render(<Harness onPageChange={slowChange} />);
    // Same dx = -700 (past the 50% threshold), but released slowly over 1400ms.
    swipeNext(get2("rail"), 800, 100, 1400);
    expect(slowChange).toHaveBeenCalledWith(1);
    const slowMs = settleMsFromRail(get2("rail"));

    expect(fastMs).not.toBeNull();
    expect(slowMs).not.toBeNull();
    // Momentum: the flick lands faster than the slow drag.
    expect(fastMs as number).toBeLessThan(slowMs as number);
    // Both stay inside the comfortable settle band.
    expect(fastMs as number).toBeGreaterThanOrEqual(320);
    expect(slowMs as number).toBeLessThanOrEqual(600);
  });

  it("a sub-threshold nudge snaps back without advancing", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<Harness onPageChange={onChange} />);
    // dx = -30: below the distance threshold and too slow to be a flick.
    swipeNext(getByTestId("rail"), 500, 470, 400);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("uses a restrained settle under prefers-reduced-motion instead of jumping", () => {
    // The live drag still tracks the finger without a transition. On release,
    // reduced motion uses a short non-bouncy settle so the page does not jump
    // discontinuously from the finger position to its resting position.
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const onChange = vi.fn();
      const { getByTestId } = render(<Harness onPageChange={onChange} />);
      const rail = getByTestId("rail");
      // Commit a swipe (crosses the 50% distance floor on the 1024px viewport).
      swipeNext(rail, 800, 100, 40);
      expect(onChange).toHaveBeenCalledWith(1);
      expect(settleMsFromRail(rail)).toBe(420);
      expect(rail.style.transition).toContain(
        "cubic-bezier(0.25, 0.1, 0.25, 1)",
      );
      expect(rail.style.getPropertyPriority("transition")).toBe("important");
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("useHorizontalPager — edge-button navigation (#10717)", () => {
  it("exposes canPrev/canNext for the current page position", () => {
    const first = render(<Harness initialPage={0} pageCount={3} />);
    expect((first.getByTestId("prev") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect((first.getByTestId("next") as HTMLButtonElement).disabled).toBe(
      false,
    );
    first.unmount();

    const last = render(<Harness initialPage={2} pageCount={3} />);
    expect((last.getByTestId("prev") as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect((last.getByTestId("next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("goNext / goPrev page exactly one view at a time", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(
      <Harness initialPage={1} pageCount={3} onPageChange={onChange} />,
    );
    act(() => {
      fireEvent.click(getByTestId("next"));
    });
    expect(onChange).toHaveBeenLastCalledWith(2);
    act(() => {
      fireEvent.click(getByTestId("prev"));
    });
    // From page 2 (after the advance), prev returns to page 1.
    expect(onChange).toHaveBeenLastCalledWith(1);
  });
});

describe("useHorizontalPager — release-velocity flick", () => {
  const opts = {
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    clientY: 300,
  } as const;

  it("commits a slow drag finished with a fast flick (release velocity, not average)", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<Harness onPageChange={onChange} />);
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      // Drag slowly to ~180px over 600ms (well under the 50% distance floor and
      // a low AVERAGE velocity ~0.3 px/ms)…
      fireEvent.pointerDown(rail, { ...opts, clientX: 800 });
      fireEvent.pointerMove(rail, { ...opts, clientX: 780 });
      clock = 1600;
      fireEvent.pointerMove(rail, { ...opts, clientX: 620 });
      // …then flick the last 120px in 20ms (release velocity ~6 px/ms).
      clock = 1620;
      fireEvent.pointerMove(rail, { ...opts, clientX: 500 });
      fireEvent.pointerUp(rail, { ...opts, clientX: 500 });
    });
    // Distance was only 300px (< 512 half-width), so this commits ONLY via the
    // fast release — the exact "drag then flick" the average-velocity path failed.
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("does not commit a drag-forward-then-fling-back release (direction guard)", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<Harness onPageChange={onChange} />);
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...opts, clientX: 800 });
      fireEvent.pointerMove(rail, { ...opts, clientX: 700 });
      clock = 1400;
      fireEvent.pointerMove(rail, { ...opts, clientX: 640 });
      // Fling BACK toward the start fast (release velocity points +x while the
      // net drag is -x) — must not commit the -x page.
      clock = 1420;
      fireEvent.pointerMove(rail, { ...opts, clientX: 760 });
      fireEvent.pointerUp(rail, { ...opts, clientX: 760 });
    });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("useHorizontalPager — right drag at the first page", () => {
  const opts = {
    pointerId: 8,
    pointerType: "touch",
    isPrimary: true,
    clientY: 300,
  } as const;

  it("rubber-bands (damped) and never commits — there is no edge-swipe commit", () => {
    runAnimationFramesImmediately();
    const onChange = vi.fn();
    const { getByTestId } = render(
      <Harness initialPage={0} onPageChange={onChange} />,
    );
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...opts, clientX: 100 });
      fireEvent.pointerMove(rail, { ...opts, clientX: 120 });
      // Slow: 500ms elapsed so neither average nor release velocity flicks.
      clock = 1500;
      fireEvent.pointerMove(rail, { ...opts, clientX: 300 });
    });
    // The rail paints the damped edge resistance (200px · 0.35 = 70px), not a
    // 1:1 pan — page 0 has nothing to its left.
    expect(rail.style.transform).toContain("70px");
    act(() => {
      clock = 1520;
      fireEvent.pointerUp(rail, { ...opts, clientX: 300 });
    });
    expect(onChange).not.toHaveBeenCalled();
    // Settles back to the resting page-0 offset.
    expect(rail.style.transform).toContain("translate3d(0px,0,0)");
  });

  it("a right drag at page > 0 pages BACK with 1:1 tracking (the launcher back-swipe path)", () => {
    runAnimationFramesImmediately();
    const onChange = vi.fn();
    const { getByTestId } = render(
      <Harness initialPage={1} onPageChange={onChange} />,
    );
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...opts, clientX: 100 });
      fireEvent.pointerMove(rail, { ...opts, clientX: 120 });
      clock = 1200;
      fireEvent.pointerMove(rail, { ...opts, clientX: 250 });
    });
    // 1:1: the rail sits at the page-1 offset plus the raw 150px drag —
    // no damping on a movable direction. jsdom width fallback is 1024.
    expect(rail.style.transform).toContain("translate3d(-874px,0,0)");
    act(() => {
      // Fast finish → flick-commit back to page 0.
      clock = 1220;
      fireEvent.pointerMove(rail, { ...opts, clientX: 320 });
      fireEvent.pointerUp(rail, { ...opts, clientX: 320 });
    });
    expect(onChange).toHaveBeenCalledWith(0);
  });
});

describe("useHorizontalPager — mouse-button guards + committed-swipe click suppression", () => {
  it("ignores a non-primary (right/middle) mouse-button press", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<Harness onPageChange={onChange} />);
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      // button 2 (context menu), buttons bitmask 2.
      fireEvent.pointerDown(rail, {
        pointerId: 9,
        pointerType: "mouse",
        isPrimary: true,
        button: 2,
        buttons: 2,
        clientX: 800,
        clientY: 300,
      });
      fireEvent.pointerMove(rail, {
        pointerId: 9,
        pointerType: "mouse",
        buttons: 2,
        clientX: 200,
        clientY: 300,
      });
      fireEvent.pointerUp(rail, {
        pointerId: 9,
        pointerType: "mouse",
        clientX: 200,
        clientY: 300,
      });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("abandons a mouse drag whose button was released off-surface (buttons=0 hover)", () => {
    runAnimationFramesImmediately();
    const onChange = vi.fn();
    const { getByTestId } = render(<Harness onPageChange={onChange} />);
    const rail = getByTestId("rail");
    const mouse = {
      pointerId: 10,
      pointerType: "mouse",
      isPrimary: true,
    } as const;
    act(() => {
      // Press with a button down, wiggle < axis-commit slop (no capture taken).
      fireEvent.pointerDown(rail, {
        ...mouse,
        button: 0,
        buttons: 1,
        clientX: 800,
        clientY: 300,
      });
      fireEvent.pointerMove(rail, {
        ...mouse,
        buttons: 1,
        clientX: 797,
        clientY: 300,
      });
      // Later hover with NO button held (release happened off-surface): the drag
      // must be abandoned, not resumed into a page change.
      fireEvent.pointerMove(rail, {
        ...mouse,
        buttons: 0,
        clientX: 300,
        clientY: 300,
      });
      fireEvent.pointerUp(rail, { ...mouse, clientX: 300, clientY: 300 });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a child's bubbled lostpointercapture mid-drag (does not self-cancel)", () => {
    runAnimationFramesImmediately();
    const onChange = vi.fn();
    const { getByTestId } = render(<Harness onPageChange={onChange} />);
    const rail = getByTestId("rail");
    const child = getByTestId("rail-child");
    const touch = {
      pointerId: 20,
      pointerType: "touch",
      isPrimary: true,
      clientY: 300,
    } as const;
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...touch, clientX: 900 });
      fireEvent.pointerMove(rail, { ...touch, clientX: 880 });
      fireEvent.pointerMove(rail, { ...touch, clientX: 700 });
      // A CHILD (the pull strip) releasing its implicit capture bubbles a
      // lostpointercapture whose target is the child, not the rail — it must not
      // abort the in-flight rail drag.
      fireEvent.lostPointerCapture(child, { ...touch });
      // The drag survives and still commits on release.
      clock = 1030;
      fireEvent.pointerUp(rail, { ...touch, clientX: 100 });
    });
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("swallows the click a committed swipe synthesizes, but not an ordinary click", () => {
    const onRailClick = vi.fn();
    const { getByTestId } = render(
      <Harness onPageChange={() => {}} onRailClick={onRailClick} />,
    );
    const rail = getByTestId("rail");
    // Ordinary click (no preceding gesture) reaches the handler.
    act(() => {
      fireEvent.click(rail);
    });
    expect(onRailClick).toHaveBeenCalledTimes(1);

    // A committed swipe arms suppression; the synthesized click is swallowed.
    onRailClick.mockClear();
    const touch = {
      pointerId: 11,
      pointerType: "touch",
      isPrimary: true,
      clientY: 300,
    } as const;
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...touch, clientX: 900 });
      fireEvent.pointerMove(rail, { ...touch, clientX: 880 });
      fireEvent.pointerMove(rail, { ...touch, clientX: 100 });
      clock = 1030;
      fireEvent.pointerUp(rail, { ...touch, clientX: 100 });
      // The browser synthesizes a click from the same press.
      fireEvent.click(rail);
    });
    expect(onRailClick).not.toHaveBeenCalled();
  });
});

describe("useHorizontalPager — pointercancel abandonment", () => {
  it("a pointercancel mid-drag settles back with no page change, even past the commit distance", () => {
    runAnimationFramesImmediately();
    const onChange = vi.fn();
    const { getByTestId } = render(<Harness onPageChange={onChange} />);
    const rail = getByTestId("rail");
    const touch = {
      pointerId: 21,
      pointerType: "touch",
      isPrimary: true,
      clientY: 300,
    } as const;
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...touch, clientX: 800 });
      fireEvent.pointerMove(rail, { ...touch, clientX: 780 });
      // dx = -700: past the 50% commit distance — a pointerup here WOULD
      // advance. The OS reclaiming the pointer must abandon it instead.
      fireEvent.pointerMove(rail, { ...touch, clientX: 100 });
      clock = 1040;
      fireEvent.pointerCancel(rail, { ...touch, clientX: 100 });
    });
    expect(onChange).not.toHaveBeenCalled();
    // The rail settles back to the resting offset of the original page.
    expect(rail.style.transform).toContain("translate3d(0px");
  });
});

describe("useHorizontalPager — drag-scoped GPU promotion (#swipe-smoothness)", () => {
  const touch = {
    pointerId: 31,
    pointerType: "touch",
    isPrimary: true,
    clientY: 300,
  } as const;

  /** Fire a transform `transitionend` on the rail, as WebKit does when a settle
   *  transition finishes (jsdom never dispatches these itself). */
  function endTransform(rail: HTMLElement) {
    act(() => {
      const ev = new Event("transitionend") as TransitionEvent;
      Object.defineProperty(ev, "propertyName", { value: "transform" });
      Object.defineProperty(ev, "target", { value: rail });
      rail.dispatchEvent(ev);
    });
  }

  it("promotes the rail at pointerdown, holds through the drag, drops on settle end", () => {
    const { getByTestId } = render(<Harness />);
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...touch, clientX: 800 });
      // Armed at pointerdown — the compositor gets the whole slop window to
      // build the layer before the first tracked frame — and the rail-gesture
      // signal opens with it.
      expect(rail.style.willChange).toBe("transform");
      expect(rail.hasAttribute("data-rail-gesture-active")).toBe(true);
      expect(isRailGestureActive()).toBe(true);
      fireEvent.pointerMove(rail, { ...touch, clientX: 770 });
    });
    expect(rail.style.willChange).toBe("transform");
    // Held through the drag frames + the release settle.
    act(() => {
      fireEvent.pointerMove(rail, { ...touch, clientX: 400 });
      clock = 1120;
      fireEvent.pointerUp(rail, { ...touch, clientX: 400 });
    });
    expect(rail.style.willChange).toBe("transform");
    expect(isRailGestureActive()).toBe(true);
    // Dropped only once the settle transition has actually ended; the
    // rail-gesture signal releases on the same edge.
    endTransform(rail);
    expect(rail.style.willChange).toBe("");
    expect(rail.hasAttribute("data-rail-gesture-active")).toBe(false);
    expect(isRailGestureActive()).toBe(false);
  });

  it("drops the pointerdown promotion the moment a gesture commits VERTICAL", () => {
    const { getByTestId } = render(<Harness />);
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...touch, clientX: 500 });
      expect(rail.style.willChange).toBe("transform");
      expect(isRailGestureActive()).toBe(true);
      // Vertical-dominant move: axis commits to Y — this is the widget list
      // scrolling, not a rail pan, so the promotion (and the signal) must
      // release immediately, not linger through the scroll.
      fireEvent.pointerMove(rail, { ...touch, clientX: 505, clientY: 400 });
      expect(rail.style.willChange).toBe("");
      expect(rail.hasAttribute("data-rail-gesture-active")).toBe(false);
      expect(isRailGestureActive()).toBe(false);
      fireEvent.pointerMove(rail, { ...touch, clientX: 505, clientY: 500 });
      clock = 1120;
      fireEvent.pointerUp(rail, { ...touch, clientX: 505, clientY: 500 });
    });
    expect(rail.style.willChange).toBe("");
    expect(isRailGestureActive()).toBe(false);
  });

  it("drops the pointerdown promotion after a plain tap (zero-delta settle, no transitionend)", () => {
    const { getByTestId } = render(<Harness />);
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...touch, clientX: 500 });
      expect(rail.style.willChange).toBe("transform");
      clock = 1050;
      // No movement: the settle writes the same transform back, so no
      // transitionend will ever fire — finish() must drop the promotion (and
      // release the signal) itself or it would leak until the next gesture.
      fireEvent.pointerUp(rail, { ...touch, clientX: 500 });
    });
    expect(rail.style.willChange).toBe("");
    expect(isRailGestureActive()).toBe(false);
  });

  it("drops the promotion when the surface unmounts mid-gesture", () => {
    const { getByTestId, unmount } = render(<Harness />);
    const rail = getByTestId("rail");
    act(() => {
      clock = 1000;
      fireEvent.pointerDown(rail, { ...touch, clientX: 800 });
      fireEvent.pointerMove(rail, { ...touch, clientX: 770 });
    });
    expect(rail.style.willChange).toBe("transform");
    // Unmount before any settle transitionend: the cleanup effect drops the
    // promoted layer so its GPU memory is not stranded.
    unmount();
    expect(rail.style.willChange).toBe("");
  });

  it("holds the promotion through the reduced-motion settle", () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      const { getByTestId } = render(<Harness />);
      const rail = getByTestId("rail");
      act(() => {
        clock = 1000;
        fireEvent.pointerDown(rail, { ...touch, clientX: 800 });
        fireEvent.pointerMove(rail, { ...touch, clientX: 770 });
        fireEvent.pointerMove(rail, { ...touch, clientX: 400 });
        clock = 1120;
        fireEvent.pointerUp(rail, { ...touch, clientX: 400 });
      });
      expect(rail.style.willChange).toBe("transform");
      expect(settleMsFromRail(rail)).toBe(420);
      expect(rail.style.getPropertyPriority("transition")).toBe("important");
      endTransform(rail);
      expect(rail.style.willChange).toBe("");
    } finally {
      window.matchMedia = original;
    }
  });
});
