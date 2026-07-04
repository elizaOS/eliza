/**
 * Storybook states for the Page Panel Frame page-panel primitive used to
 * compose dense dashboard pages.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { PagePanelContentArea, PagePanelFrame } from "./page-panel-frame";

const SCROLL_ROWS = Array.from({ length: 30 }, (_, i) => ({
  id: `scroll-row-${i + 1}`,
  label: `Item ${i + 1}`,
}));

const meta = {
  title: "Composites/PagePanel/PagePanelFrame",
  component: PagePanelFrame,
  tags: ["autodocs"],
  args: {
    children: (
      <PagePanelContentArea className="rounded-md border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">Panel frame content</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          PagePanelFrame is a thin layout wrapper that fills its parent and
          applies a small responsive padding. Slot a PagePanelContentArea or any
          scroll container inside.
        </p>
      </PagePanelContentArea>
    ),
  },
} satisfies Meta<typeof PagePanelFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithScrollableContent: Story = {
  args: {
    children: (
      <PagePanelContentArea className="rounded-md border border-border bg-card p-4">
        <h2 className="text-lg font-semibold">Scrollable content</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {SCROLL_ROWS.map((row) => (
            <li
              key={row.id}
              className="rounded border border-border/60 bg-muted/30 px-3 py-2"
            >
              {row.label}
            </li>
          ))}
        </ul>
      </PagePanelContentArea>
    ),
  },
  decorators: [
    (Story) => (
      <div className="h-72 w-full">
        <Story />
      </div>
    ),
  ],
};

export const SplitLayout: Story = {
  args: {
    children: (
      <>
        <aside className="hidden w-56 shrink-0 rounded-md border border-border bg-card p-3 text-sm lg:block">
          <div className="font-medium">Sidebar</div>
          <ul className="mt-2 space-y-1 text-muted-foreground">
            <li>Overview</li>
            <li>Members</li>
            <li>Settings</li>
          </ul>
        </aside>
        <PagePanelContentArea className="ml-0 rounded-md border border-border bg-card p-4 lg:ml-2">
          <h2 className="text-lg font-semibold">Main area</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The frame is a flex row; pair a sidebar with PagePanelContentArea to
            get a typical split panel layout.
          </p>
        </PagePanelContentArea>
      </>
    ),
  },
  decorators: [
    (Story) => (
      <div className="h-80 w-full">
        <Story />
      </div>
    ),
  ],
};

export const EmptyFrame: Story = {
  args: {
    children: (
      <PagePanelContentArea className="flex items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/20 p-6 text-sm text-muted-foreground">
        Nothing here yet
      </PagePanelContentArea>
    ),
  },
};
