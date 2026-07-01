// @vitest-environment jsdom
//
// Unit coverage for useHorizontalPager (#10717): velocity-aware momentum settle
// (a fast flick settles quicker than a slow drag over the same distance) and the
// pointer edge-button surface (canPrev/canNext + goPrev/goNext one-page nav).
// Drives REAL React pointer events through the hook and reads the transition the
// hook writes to the rail; performance.now is mocked to make release velocity
// deterministic.

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    // dx = -300 (crosses the distance threshold → advances), released in 40ms.
    swipeNext(getByTestId("rail"), 500, 200, 40);
    expect(fastChange).toHaveBeenCalledWith(1);
    const fastMs = settleMsFromRail(getByTestId("rail"));
    unmount();

    const slowChange = vi.fn();
    const { getByTestId: get2 } = render(<Harness onPageChange={slowChange} />);
    // Same dx = -300, but released slowly over 700ms.
    swipeNext(get2("rail"), 500, 200, 700);
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
