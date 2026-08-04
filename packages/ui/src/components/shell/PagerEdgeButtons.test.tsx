/** Verifies PagerEdgeButtons (#10717) through the package's configured test harness. */
// @vitest-environment jsdom
//
// #10717: the web/desktop `< >` pager edge buttons — desktop-width and
// fine-pointer gated, self-hiding at the first/last page, click →
// goPrev/goNext.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINE_POINTER_EDGE_BUTTON_QUERY,
  PagerEdgeButtons,
} from "./PagerEdgeButtons";

function mockPointerCapability({
  finePointer,
  desktopViewport = true,
}: {
  finePointer: boolean;
  desktopViewport?: boolean;
}) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      finePointer &&
      desktopViewport &&
      query.includes("(min-width: 768px)") &&
      query.includes("(hover: hover)") &&
      query.includes("(pointer: fine)"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PagerEdgeButtons (#10717)", () => {
  it("renders nothing on touch / coarse pointers", () => {
    mockPointerCapability({ finePointer: false });
    const { queryByTestId } = render(
      <PagerEdgeButtons canPrev canNext goPrev={vi.fn()} goNext={vi.fn()} />,
    );
    expect(queryByTestId("pager-edge-prev")).toBeNull();
    expect(queryByTestId("pager-edge-next")).toBeNull();
  });

  it("renders nothing in a mobile-width viewport even when the pointer is fine", () => {
    mockPointerCapability({ finePointer: true, desktopViewport: false });
    const { queryByTestId } = render(
      <PagerEdgeButtons canPrev canNext goPrev={vi.fn()} goNext={vi.fn()} />,
    );
    expect(queryByTestId("pager-edge-prev")).toBeNull();
    expect(queryByTestId("pager-edge-next")).toBeNull();
    expect(window.matchMedia).toHaveBeenCalledWith(
      expect.stringContaining("min-width: 768px"),
    );
  });

  it("renders both arrows on fine pointers and routes clicks", () => {
    mockPointerCapability({ finePointer: true });
    const goPrev = vi.fn();
    const goNext = vi.fn();
    const { getByTestId } = render(
      <PagerEdgeButtons canPrev canNext goPrev={goPrev} goNext={goNext} />,
    );
    fireEvent.click(getByTestId("pager-edge-prev"));
    fireEvent.click(getByTestId("pager-edge-next"));
    expect(goPrev).toHaveBeenCalledTimes(1);
    expect(goNext).toHaveBeenCalledTimes(1);
  });

  it("hides the arrow with no page to move to (first / last page)", () => {
    mockPointerCapability({ finePointer: true });
    const first = render(
      <PagerEdgeButtons
        canPrev={false}
        canNext
        goPrev={vi.fn()}
        goNext={vi.fn()}
      />,
    );
    expect(first.queryByTestId("pager-edge-prev")).toBeNull();
    expect(first.queryByTestId("pager-edge-next")).not.toBeNull();
    first.unmount();

    const last = render(
      <PagerEdgeButtons
        canPrev
        canNext={false}
        goPrev={vi.fn()}
        goNext={vi.fn()}
      />,
    );
    expect(last.queryByTestId("pager-edge-prev")).not.toBeNull();
    expect(last.queryByTestId("pager-edge-next")).toBeNull();
  });
});

// The first-session swipe hint (#13453 debt 5) renders exactly where these
// buttons do not: both surfaces evaluate this ONE exported query, so the
// complement cannot drift into showing both teaching affordances (or neither)
// on a single device.
describe("FINE_POINTER_EDGE_BUTTON_QUERY complement contract", () => {
  it("gates the buttons on exactly this query, nothing else", () => {
    mockPointerCapability({ finePointer: true });
    render(
      <PagerEdgeButtons canPrev canNext goPrev={vi.fn()} goNext={vi.fn()} />,
    );
    expect(window.matchMedia).toHaveBeenCalledWith(
      FINE_POINTER_EDGE_BUTTON_QUERY,
    );
  });
});
