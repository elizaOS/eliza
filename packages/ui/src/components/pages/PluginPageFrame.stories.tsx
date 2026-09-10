/** Storybook coverage for the shared frame used by plugin-owned pages. */

import type { Meta, StoryObj } from "@storybook/react";
import { PluginPageFrame } from "./PluginPageFrame";

const meta = {
  title: "Pages/PluginPageFrame",
  component: PluginPageFrame,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <div className="h-[32rem] bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PluginPageFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ScrollableContent: Story = {
  args: {
    title: "Calendar",
    contentOverflow: "auto",
    children: (
      <div className="space-y-3 p-4">
        {[
          "Planning review",
          "Design sync",
          "Lunch",
          "Release check",
          "Customer call",
          "Research block",
          "Team standup",
          "Documentation",
          "QA handoff",
          "Retrospective",
          "Focus time",
          "Daily closeout",
        ].map((label) => (
          <div
            className="rounded-lg border border-border bg-card p-4"
            key={label}
          >
            {label}
          </div>
        ))}
      </div>
    ),
  },
};

export const ClippedCanvas: Story = {
  args: {
    title: "Canvas",
    contentOverflow: "hidden",
    safeAreaTop: true,
    children: (
      <div className="grid h-full place-items-center bg-muted">
        Plugin-owned canvas
      </div>
    ),
  },
};
