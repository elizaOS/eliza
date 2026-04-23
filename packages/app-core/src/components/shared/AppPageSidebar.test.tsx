// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppPageSidebar } from "./AppPageSidebar";

function installMatchMediaMock(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === "(min-width: 768px)",
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe("AppPageSidebar", () => {
  beforeEach(() => {
    installMatchMediaMock();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
    cleanup();
  });

  it("keeps the collapsed expand trigger aligned with the inline footer control", () => {
    const { rerender } = render(
      <AppPageSidebar
        testId="page-sidebar"
        collapsible
        collapsed={false}
        contentIdentity="page-sidebar"
        expandButtonTestId="page-sidebar-expand-toggle"
      >
        <div>Sidebar body</div>
      </AppPageSidebar>,
    );

    const collapseInlineButton = screen.getByTestId(
      "page-sidebar-collapse-inline",
    );
    expect(collapseInlineButton.className).toContain("h-6");
    expect(collapseInlineButton.className).toContain("w-6");
    expect(collapseInlineButton.className).toContain("bg-transparent");

    rerender(
      <AppPageSidebar
        testId="page-sidebar"
        collapsible
        collapsed
        contentIdentity="page-sidebar"
        expandButtonTestId="page-sidebar-expand-toggle"
      >
        <div>Sidebar body</div>
      </AppPageSidebar>,
    );

    const expandButton = screen.getByTestId("page-sidebar-expand-toggle");
    expect(expandButton.className).toContain("bottom-2");
    expect(expandButton.className).toContain("left-2");
    expect(expandButton.className).toContain("h-6");
    expect(expandButton.className).toContain("w-6");
    expect(expandButton.className).toContain("bg-transparent");
    expect(expandButton.className).not.toContain("shadow-sm");
    expect(expandButton.className).not.toContain("hover:!bg-bg-muted/60");
  });
});
