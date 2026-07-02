// @vitest-environment jsdom
//
// Unit coverage for useHorizontalPager (#10717): velocity-aware momentum settle
// (a fast flick settles quicker than a slow drag over the same distance), the
// pointer edge-button surface (canPrev/canNext + goPrev/goNext one-page nav),
// and the nested-pager claim registry (one horizontal drag is owned by exactly
// one pager along the bubble path). Drives REAL React pointer events through
// the hook and reads the transition the hook writes to the rail;
// performance.now is mocked to make release velocity deterministic.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnimationFramesImmediately } from "../testing/run-animation-frames-immediately";
import { useHorizontalPager } from "./useHorizontalPager";

let clock = 1000;

beforeEach(() => {
  clock = 1000;
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
}: {
  initialPage?: number;
  pageCount?: number;
  onPageChange?: (page: number) => void;
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
        <div
          data-testid="rail"
          ref={pager.railRef}
          onPointerDown={pager.handlers.onPointerDown}
          onPointerMove={pager.handlers.onPointerMove}
          onPointerUp={pager.handlers.onPointerUp}
          onPointerCancel={pager.handlers.onPointerCancel}
          onLostPointerCapture={pager.handlers.onLostPointerCapture}
        />
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
    // Same dx = -700 (past the 50% threshold), but released slowly over 700ms.
    swipeNext(get2("rail"), 800, 100, 700);
    expect(slowChange).toHaveBeenCalledWith(1);
    const slowMs = settleMsFromRail(get2("rail"));

    expect(fastMs).not.toBeNull();
    expect(slowMs).not.toBeNull();
    // Momentum: the flick lands faster than the slow drag.
    expect(fastMs as number).toBeLessThan(slowMs as number);
    // Both stay inside the comfortable settle band.
    expect(fastMs as number).toBeGreaterThanOrEqual(130);
    expect(slowMs as number).toBeLessThanOrEqual(440);
  });

  it("a sub-threshold nudge snaps back without advancing", () => {
    const onChange = vi.fn();
    const { getByTestId } = render(<Harness onPageChange={onChange} />);
    // dx = -30: below the distance threshold and too slow to be a flick.
    swipeNext(getByTestId("rail"), 500, 470, 400);
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * Two REAL pagers nested along one bubble path, mirroring the home↔launcher
 * rail (outer, 2 pages, resting on its last page) wrapping the launcher grid
 * pager (inner, 3 pages): pointer events fired on the tile bubble through the
 * inner pager's handlers first, then the outer's — the exact composition the
 * shared claim registry arbitrates.
 */
function NestedHarness({
  innerInitialPage = 0,
  onOuterPageChange,
  onInnerPageChange,
}: {
  innerInitialPage?: number;
  onOuterPageChange?: (page: number) => void;
  onInnerPageChange?: (page: number) => void;
}): React.JSX.Element {
  const [outerPage, setOuterPage] = React.useState(1);
  const [innerPage, setInnerPage] = React.useState(innerInitialPage);
  const outer = useHorizontalPager({
    page: outerPage,
    pageCount: 2,
    onPageChange: (next) => {
      onOuterPageChange?.(next);
      setOuterPage(next);
    },
  });
  const inner = useHorizontalPager({
    page: innerPage,
    pageCount: 3,
    onPageChange: (next) => {
      onInnerPageChange?.(next);
      setInnerPage(next);
    },
  });
  return (
    <div ref={outer.viewportRef}>
      <div data-testid="outer-rail" ref={outer.railRef}>
        <div
          data-testid="outer-page"
          onPointerDown={outer.handlers.onPointerDown}
          onPointerMove={outer.handlers.onPointerMove}
          onPointerUp={outer.handlers.onPointerUp}
          onPointerCancel={outer.handlers.onPointerCancel}
          onLostPointerCapture={outer.handlers.onLostPointerCapture}
        >
          <div
            ref={inner.viewportRef}
            data-testid="inner-viewport"
            onPointerDown={inner.handlers.onPointerDown}
            onPointerMove={inner.handlers.onPointerMove}
            onPointerUp={inner.handlers.onPointerUp}
            onPointerCancel={inner.handlers.onPointerCancel}
            onLostPointerCapture={inner.handlers.onLostPointerCapture}
          >
            <div data-testid="inner-rail" ref={inner.railRef}>
              <div data-testid="inner-tile" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

describe("useHorizontalPager — nested-pager gesture arbitration", () => {
  it("a leftward touch drag the inner pager can move on is claimed by it — the outer never tracks or paints", () => {
    runAnimationFramesImmediately();
    const outerChange = vi.fn();
    const innerChange = vi.fn();
    const { getByTestId } = render(
      <NestedHarness
        onOuterPageChange={outerChange}
        onInnerPageChange={innerChange}
      />,
    );
    const tile = getByTestId("inner-tile");
    const outerRail = getByTestId("outer-rail");
    const outerResting = outerRail.style.transform;
    const opts = {
      pointerId: 21,
      pointerType: "touch",
      isPrimary: true,
      clientY: 300,
    } as const;

    act(() => {
      fireEvent.pointerDown(tile, { ...opts, clientX: 500 });
      fireEvent.pointerMove(tile, { ...opts, clientX: 480 });
      fireEvent.pointerMove(tile, { ...opts, clientX: 200 });
    });
    // The inner rail follows the finger 1:1 …
    expect(getByTestId("inner-rail").style.transform).toContain("-300px");
    // … while the outer rail must not move at all (it used to paint its own
    // rubber-band on top, translating both rails for one finger).
    expect(outerRail.style.transform).toBe(outerResting);

    act(() => {
      clock = 1050;
      fireEvent.pointerUp(tile, { ...opts, clientX: 200 });
    });
    expect(innerChange).toHaveBeenCalledWith(1);
    expect(outerChange).not.toHaveBeenCalled();
  });

  it("a leftward MOUSE drag advances the inner pager — the outer no longer steals the gesture via pointer capture", () => {
    runAnimationFramesImmediately();
    const outerChange = vi.fn();
    const innerChange = vi.fn();
    const { getByTestId } = render(
      <NestedHarness
        onOuterPageChange={outerChange}
        onInnerPageChange={innerChange}
      />,
    );
    const tile = getByTestId("inner-tile");
    const opts = {
      pointerId: 22,
      pointerType: "mouse",
      isPrimary: true,
      clientY: 300,
    } as const;

    act(() => {
      fireEvent.pointerDown(tile, { ...opts, clientX: 500 });
      fireEvent.pointerMove(tile, { ...opts, clientX: 480 });
      fireEvent.pointerMove(tile, { ...opts, clientX: 200 });
      clock = 1050;
      fireEvent.pointerUp(tile, { ...opts, clientX: 200 });
    });
    expect(innerChange).toHaveBeenCalledWith(1);
    expect(outerChange).not.toHaveBeenCalled();
  });

  it("a rightward drag the inner pager CANNOT move on falls through to the outer rail", () => {
    runAnimationFramesImmediately();
    const outerChange = vi.fn();
    const innerChange = vi.fn();
    const { getByTestId } = render(
      <NestedHarness
        onOuterPageChange={outerChange}
        onInnerPageChange={innerChange}
      />,
    );
    const tile = getByTestId("inner-tile");
    const opts = {
      pointerId: 23,
      pointerType: "touch",
      isPrimary: true,
      clientY: 300,
    } as const;

    act(() => {
      fireEvent.pointerDown(tile, { ...opts, clientX: 200 });
      fireEvent.pointerMove(tile, { ...opts, clientX: 220 });
      fireEvent.pointerMove(tile, { ...opts, clientX: 520 });
    });
    // The outer claimed the gesture on the commit move, evicting the inner —
    // the inner rail must sit back at its resting page, not rubber-band along.
    expect(getByTestId("inner-rail").style.transform).toContain(
      "translate3d(0px,0,0)",
    );

    act(() => {
      clock = 1050;
      fireEvent.pointerUp(tile, { ...opts, clientX: 520 });
    });
    expect(outerChange).toHaveBeenCalledWith(0);
    expect(innerChange).not.toHaveBeenCalled();
  });

  it("an unowned dead-end drag rubber-bands the INNERMOST pager only", () => {
    runAnimationFramesImmediately();
    const outerChange = vi.fn();
    const innerChange = vi.fn();
    const { getByTestId } = render(
      <NestedHarness
        innerInitialPage={2}
        onOuterPageChange={outerChange}
        onInnerPageChange={innerChange}
      />,
    );
    const tile = getByTestId("inner-tile");
    const outerRail = getByTestId("outer-rail");
    const outerResting = outerRail.style.transform;
    const opts = {
      pointerId: 24,
      pointerType: "touch",
      isPrimary: true,
      clientY: 300,
    } as const;

    // Both pagers sit on their last page: neither can move left, so nobody
    // claims — the drag stays unowned.
    act(() => {
      fireEvent.pointerDown(tile, { ...opts, clientX: 500 });
      fireEvent.pointerMove(tile, { ...opts, clientX: 480 });
      fireEvent.pointerMove(tile, { ...opts, clientX: 300 });
    });
    // Inner (innermost): base -2 pages × 1024px, plus dx·0.35 resistance.
    expect(getByTestId("inner-rail").style.transform).toContain("-2118px");
    // Outer: no edge resistance for a gesture it does not own.
    expect(outerRail.style.transform).toBe(outerResting);

    act(() => {
      clock = 1050;
      fireEvent.pointerUp(tile, { ...opts, clientX: 300 });
    });
    expect(outerChange).not.toHaveBeenCalled();
    expect(innerChange).not.toHaveBeenCalled();
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
