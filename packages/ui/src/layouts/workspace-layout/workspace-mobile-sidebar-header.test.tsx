// @vitest-environment jsdom

/**
 * Verifies the mobile sidebar trigger lives in the view header, not the content
 * flow: `useWorkspaceMobileSidebarHeader` + `WorkspaceMobileSidebarScope`
 * suppress the inline `page-layout-mobile-sidebar-trigger` button and surface
 * the registered drawer as a compact `ViewHeaderSidebarTrigger` in the header's
 * right slot, keeping the documented testid for drawer-opening helpers.
 * Renders against jsdom (no real viewport).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppPageSidebar } from "../../components/shared/AppPageSidebar";
import { ViewHeader } from "../../components/shared/ViewHeader";
import { ViewHeaderSidebarTrigger } from "../../components/shared/ViewHeaderSidebarTrigger";
import { PageLayout } from "../page-layout/page-layout";
import { useWorkspaceMobileSidebarHeader } from "./workspace-mobile-sidebar-controls.hooks";
import { WorkspaceMobileSidebarScope } from "./workspace-mobile-sidebar-scope";

function mockViewport({ desktop }: { desktop: boolean }) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    // WorkspaceLayout gates the drawer on "(min-width: 820px)"; every other
    // query (pointer/hover probes from primitives) reports no match.
    matches: desktop && query.includes("min-width: 820px"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function sidebarElement() {
  return (
    <AppPageSidebar testId="fixture-sidebar" mobileTitle="People">
      <div>sidebar body</div>
    </AppPageSidebar>
  );
}

/** A view WITHOUT the header scope — the legacy inline-trigger layout. */
function UnscopedFixture() {
  return (
    <div>
      <ViewHeader title="Fixture" />
      <PageLayout sidebar={sidebarElement()}>
        <div>content</div>
      </PageLayout>
    </div>
  );
}

/** A view WITH the header scope — trigger lives in the ViewHeader right slot. */
function ScopedFixture() {
  const mobileSidebarHeader = useWorkspaceMobileSidebarHeader();
  return (
    <div>
      <ViewHeader
        title="Fixture"
        right={
          <ViewHeaderSidebarTrigger control={mobileSidebarHeader.control} />
        }
      />
      <WorkspaceMobileSidebarScope controls={mobileSidebarHeader.controls}>
        <PageLayout sidebar={sidebarElement()}>
          <div>content</div>
        </PageLayout>
      </WorkspaceMobileSidebarScope>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("mobile sidebar header trigger", () => {
  it("without a scope, mobile keeps the inline trigger below the header (legacy layouts)", () => {
    mockViewport({ desktop: false });
    render(<UnscopedFixture />);

    const trigger = screen.getByTestId("page-layout-mobile-sidebar-trigger");
    expect(trigger.textContent).toContain("People");
    // Inline variant: rendered inside the layout's main pane, not the header.
    expect(
      within(screen.getByTestId("view-header")).queryByTestId(
        "page-layout-mobile-sidebar-trigger",
      ),
    ).toBeNull();
    expect(trigger.closest("main")).not.toBeNull();
  });

  it("with a scope, mobile renders the trigger in the header right slot and nothing in the content flow", () => {
    mockViewport({ desktop: false });
    render(<ScopedFixture />);

    const triggers = screen.getAllByTestId(
      "page-layout-mobile-sidebar-trigger",
    );
    expect(triggers).toHaveLength(1);
    const [trigger] = triggers;
    expect(trigger.textContent).toContain("People");
    // Header variant: inside the ViewHeader, outside the layout's main pane.
    expect(
      within(screen.getByTestId("view-header")).getByTestId(
        "page-layout-mobile-sidebar-trigger",
      ),
    ).toBe(trigger);
    expect(trigger.closest("main")).toBeNull();
  });

  it("header trigger opens the drawer, hides while open, and returns on close", () => {
    mockViewport({ desktop: false });
    render(<ScopedFixture />);

    expect(
      screen.queryByTestId("page-layout-mobile-sidebar-drawer"),
    ).toBeNull();

    fireEvent.click(screen.getByTestId("page-layout-mobile-sidebar-trigger"));

    const drawer = screen.getByTestId("page-layout-mobile-sidebar-drawer");
    expect(within(drawer).getByText("sidebar body")).not.toBeNull();
    // Drawer owns the close affordance; the header trigger steps aside.
    expect(
      screen.queryByTestId("page-layout-mobile-sidebar-trigger"),
    ).toBeNull();

    fireEvent.click(within(drawer).getByTestId("conversations-mobile-close"));

    expect(
      screen.queryByTestId("page-layout-mobile-sidebar-drawer"),
    ).toBeNull();
    expect(
      screen.getByTestId("page-layout-mobile-sidebar-trigger").textContent,
    ).toContain("People");
  });

  it("desktop renders the sidebar inline with no trigger anywhere", () => {
    mockViewport({ desktop: true });
    render(<ScopedFixture />);

    expect(screen.getByTestId("fixture-sidebar")).not.toBeNull();
    expect(
      screen.queryByTestId("page-layout-mobile-sidebar-trigger"),
    ).toBeNull();
    expect(
      screen.queryByTestId("page-layout-mobile-sidebar-drawer"),
    ).toBeNull();
  });
});
