// @vitest-environment jsdom
//
// #10717: the web/desktop `< >` pager edge buttons — fine-pointer gated
// (never on touch/coarse pointers, but at ANY viewport width), self-hiding at
// the first/last page, click → goPrev/goNext.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FINE_POINTER_EDGE_BUTTON_QUERY,
  PagerEdgeButtons,
} from "./PagerEdgeButtons";

function mockPointerCapability({ finePointer }: { finePointer: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches:
      finePointer &&
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

  it("gates on pointer capability only — no min-width clause, so a narrow fine-pointer window still gets a paging control", () => {
    mockPointerCapability({ finePointer: true });
    const { queryByTestId } = render(
      <PagerEdgeButtons canPrev canNext goPrev={vi.fn()} goNext={vi.fn()} />,
    );
    // The buttons render from the pointer-capability match alone; the media
    // gate never consults the viewport width (below 1024px there are no page
    // dots in production, so these arrows are the only paging control).
    expect(queryByTestId("pager-edge-prev")).not.toBeNull();
    expect(queryByTestId("pager-edge-next")).not.toBeNull();
    expect(window.matchMedia).toHaveBeenCalledWith(
      expect.not.stringContaining("min-width"),
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

  it("uses neutral icon color with no card chrome or blue", () => {
    mockPointerCapability({ finePointer: true });
    const { getByTestId } = render(
      <PagerEdgeButtons canPrev canNext goPrev={vi.fn()} goNext={vi.fn()} />,
    );
    const cls = getByTestId("pager-edge-next").className;
    expect(cls).toContain("text-white/55");
    expect(cls).toContain("hover:text-white");
    expect(cls).not.toMatch(/border|rounded-|bg-(black|white|blue)/);
  });
});

// The first-session swipe hint (#13453 debt 5) renders exactly where these
// buttons do not: both surfaces evaluate this ONE exported query, so the
// complement cannot drift into showing both teaching affordances (or neither)
// on a single device.
describe("FINE_POINTER_EDGE_BUTTON_QUERY complement contract", () => {
  it("is the exact fine-pointer query FirstSessionSwipeHint inverts", () => {
    expect(FINE_POINTER_EDGE_BUTTON_QUERY).toBe(
      "(hover: hover) and (pointer: fine)",
    );
  });

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
