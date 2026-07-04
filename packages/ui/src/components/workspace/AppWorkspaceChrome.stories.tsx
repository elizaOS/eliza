/** Storybook stories for AppWorkspaceChrome — default (with nav) and no-nav layouts. */

import type { Meta, StoryObj } from "@storybook/react";
import { AppWorkspaceChrome } from "./AppWorkspaceChrome";

const navPlaceholder = (
  <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border/40 bg-card/80 px-4 text-sm">
    <span className="font-medium text-txt">Workspace</span>
    <span className="text-muted">/ Inbox</span>
  </div>
);

const mainRows = Array.from({ length: 4 }, (_, i) => ({
  id: `main-row-${i + 1}`,
  label: `Item ${i + 1}`,
}));

const mainPlaceholder = (
  <div className="flex flex-1 flex-col gap-4 overflow-auto p-6">
    <h1 className="text-2xl font-semibold text-txt">Inbox</h1>
    <p className="text-muted">
      Main pane content area. This is the primary surface a workspace page
      renders into.
    </p>
    <div className="grid gap-3">
      {mainRows.map((row) => (
        <div
          key={row.id}
          className="rounded-md border border-border/40 bg-card/60 p-3"
        >
          <div className="text-sm font-medium text-txt">{row.label}</div>
          <div className="text-xs text-muted">
            Placeholder row demonstrating layout flow.
          </div>
        </div>
      ))}
    </div>
  </div>
);

const meta = {
  title: "Workspace/AppWorkspaceChrome",
  component: AppWorkspaceChrome,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-full bg-bg text-txt">
        <Story />
      </div>
    ),
  ],
  args: {
    nav: navPlaceholder,
    main: mainPlaceholder,
  },
} satisfies Meta<typeof AppWorkspaceChrome>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoNav: Story = {
  args: {
    nav: undefined,
  },
};
