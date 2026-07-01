// @vitest-environment jsdom
//
// #10717: the web/desktop `< >` pager edge buttons — fine-pointer gated (never
// on touch), self-hiding at the first/last page, click → goPrev/goNext.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PagerEdgeButtons } from "./PagerEdgeButtons";

function mockPointer(fine: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    // Only the fine-pointer/hover query resolves to `fine`.
    matches: /hover: hover/.test(query) ? fine : false,
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
    mockPointer(false);
    const { queryByTestId } = render(
      <PagerEdgeButtons canPrev canNext goPrev={vi.fn()} goNext={vi.fn()} />,
    );
    expect(queryByTestId("pager-edge-prev")).toBeNull();
    expect(queryByTestId("pager-edge-next")).toBeNull();
  });

  it("renders both arrows on fine pointers and routes clicks", () => {
    mockPointer(true);
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
    mockPointer(true);
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
    mockPointer(true);
    const { getByTestId } = render(
      <PagerEdgeButtons canPrev canNext goPrev={vi.fn()} goNext={vi.fn()} />,
    );
    const cls = getByTestId("pager-edge-next").className;
    expect(cls).toContain("text-white/55");
    expect(cls).toContain("hover:text-white");
    expect(cls).not.toMatch(/border|rounded-|bg-(black|white|blue)/);
  });
});
