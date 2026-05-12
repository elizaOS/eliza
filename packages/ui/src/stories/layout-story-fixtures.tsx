import type { ReactNode } from "react";

import { Button } from "../components/ui/button";
import { PagePanel } from "../components/composites/page-panel";
import { Sidebar } from "../components/composites/sidebar/sidebar-root";
import { SidebarContent } from "../components/composites/sidebar/sidebar-content";
import { SidebarHeader } from "../components/composites/sidebar/sidebar-header";
import { SidebarPanel } from "../components/composites/sidebar/sidebar-panel";
import { SidebarScrollRegion } from "../components/composites/sidebar/sidebar-scroll-region";

export function LayoutStoryFrame({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen bg-bg">{children}</div>;
}

export function LayoutStorySidebar() {
  return (
    <Sidebar
      collapsible
      contentIdentity="storybook-layout"
      mobileTitle="Sections"
      header={
        <SidebarHeader
          search={{
            value: "",
            onChange: () => {},
            placeholder: "Search sections",
            "aria-label": "Search sections",
          }}
        />
      }
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          <nav className="space-y-1" aria-label="Demo sections">
            <SidebarContent.Item active>
              <SidebarContent.ItemTitle>Overview</SidebarContent.ItemTitle>
            </SidebarContent.Item>
            <SidebarContent.Item>
              <SidebarContent.ItemTitle>Details</SidebarContent.ItemTitle>
            </SidebarContent.Item>
            <SidebarContent.Item>
              <SidebarContent.ItemTitle>History</SidebarContent.ItemTitle>
            </SidebarContent.Item>
            <SidebarContent.Item>
              <SidebarContent.ItemTitle>Widgets</SidebarContent.ItemTitle>
            </SidebarContent.Item>
          </nav>
        </SidebarPanel>
      </SidebarScrollRegion>
    </Sidebar>
  );
}

export function LayoutStoryHeader() {
  return (
    <div className="mx-auto flex w-full max-w-[72rem] flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted">
          Shell header
        </div>
        <div className="truncate text-sm font-medium text-txt">
          Shared content header slot
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline">
          Filter
        </Button>
        <Button size="sm">Create</Button>
      </div>
    </div>
  );
}

export function LayoutStoryFooter() {
  return (
    <div className="mx-auto w-full max-w-[72rem]">
      <div className="rounded-[1.5rem] border border-border/40 bg-card/75 px-4 py-3 text-sm text-muted shadow-sm">
        Supplementary widget/footer slot
      </div>
    </div>
  );
}

export function LayoutStoryContent() {
  const primarySections = [
    "Section 1",
    "Section 2",
    "Section 3",
    "Section 4",
  ] as const;

  return (
    <div className="mx-auto flex w-full max-w-[72rem] flex-1 flex-col gap-4">
      <PagePanel variant="workspace" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-muted">
              Layout contract
            </div>
            <h2 className="mt-1 text-lg font-semibold text-txt">
              Shared page shell
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline">
              Secondary
            </Button>
            <Button size="sm">Primary</Button>
          </div>
        </div>
        <p className="max-w-3xl text-sm text-muted">
          This story exercises the standardized app page structure: optional
          left sidebar, scrollable main column, shared header slot, and a
          supplementary widget/footer region.
        </p>
      </PagePanel>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_0.65fr]">
        <PagePanel variant="workspace" className="space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
            Primary content
          </div>
          <div className="space-y-3">
            {primarySections.map((sectionLabel) => (
              <div
                key={sectionLabel}
                className="rounded-2xl border border-border/40 bg-bg/40 p-4"
              >
                <div className="text-sm font-medium text-txt">
                  {sectionLabel}
                </div>
                <p className="mt-1 text-sm text-muted">
                  Responsive spacing, sidebar behavior, and the footer widget
                  slot should remain consistent across every page shape.
                </p>
              </div>
            ))}
          </div>
        </PagePanel>

        <PagePanel variant="workspace" className="space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
            Supporting column
          </div>
          <div className="space-y-2">
            <div className="rounded-2xl border border-border/40 bg-bg/40 p-4 text-sm text-muted">
              Use this area to verify long-form content, summary cards, or
              right-column panels at tablet and desktop breakpoints.
            </div>
            <div className="rounded-2xl border border-border/40 bg-bg/40 p-4 text-sm text-muted">
              On narrow widths the column naturally stacks under the primary
              content.
            </div>
          </div>
        </PagePanel>
      </div>
    </div>
  );
}

export const fullLayoutArgs = {
  contentHeader: <LayoutStoryHeader />,
  footer: <LayoutStoryFooter />,
  sidebar: <LayoutStorySidebar />,
};
