/** Storybook coverage for the router-owned workspace content boundary. */

import type { Meta, StoryObj } from "@storybook/react";
import { ViewHeader } from "../shared/ViewHeader";
import { AppWorkspaceContent } from "./AppWorkspaceContent";

const rows = Array.from({ length: 12 }, (_, index) => ({
  id: `workspace-content-row-${index + 1}`,
  label: `Activity ${index + 1}`,
}));

const body = (
  <div className="grid gap-2 p-4">
    {rows.map((row) => (
      <div
        key={row.id}
        className="min-h-12 rounded-md border border-border/40 bg-card/60 px-4 py-3 text-sm text-txt"
      >
        {row.label}
      </div>
    ))}
  </div>
);

const meta = {
  title: "Workspace/AppWorkspaceContent",
  component: AppWorkspaceContent,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex h-[600px] w-full bg-bg text-txt">
        <Story />
      </div>
    ),
  ],
  args: {
    children: body,
    header: <ViewHeader title="Activity" />,
  },
} satisfies Meta<typeof AppWorkspaceContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ContainedView: Story = {};

export const RouterOwnedScroll: Story = {
  args: { layout: "scroll" },
};
