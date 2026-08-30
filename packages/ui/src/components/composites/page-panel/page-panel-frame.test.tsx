// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PagePanelContentArea,
  PagePanelContentRail,
  PagePanelFrame,
} from "./page-panel-frame";

describe("PagePanel routed-view layout", () => {
  afterEach(cleanup);

  it("can provide the semantic view root without taking scroll ownership", () => {
    render(
      <PagePanelFrame as="main" aria-label="Notes" className="flex-col">
        <div>Fixed header</div>
        <PagePanelContentArea aria-label="Notes content">
          <PagePanelContentRail width="compact">
            Notes body
          </PagePanelContentRail>
        </PagePanelContentArea>
      </PagePanelFrame>,
    );

    const root = screen.getByRole("main", { name: "Notes" });
    const scrollArea = screen.getByLabelText("Notes content");
    const rail = screen.getByText("Notes body");

    expect(root.classList.contains("h-full")).toBe(true);
    expect(root.classList.contains("min-h-0")).toBe(true);
    expect(root.classList.contains("flex-col")).toBe(true);
    expect(scrollArea.classList.contains("min-h-0")).toBe(true);
    expect(scrollArea.classList.contains("overflow-y-auto")).toBe(true);
    expect(scrollArea.classList.contains("overscroll-contain")).toBe(true);
    expect(root.classList.contains("overflow-y-auto")).toBe(false);
    expect(rail.classList.contains("max-w-3xl")).toBe(true);
    expect(rail.classList.contains("px-4")).toBe(true);
    expect(rail.classList.contains("sm:px-6")).toBe(true);
  });

  it.each([
    ["compact", "max-w-3xl"],
    ["standard", "max-w-[820px]"],
    ["wide", "max-w-5xl"],
  ] as const)("maps the %s width to its shared rail", (width, className) => {
    const { container } = render(
      <PagePanelContentRail width={width}>Rail</PagePanelContentRail>,
    );
    expect(container.firstElementChild?.classList.contains(className)).toBe(
      true,
    );
  });
});
