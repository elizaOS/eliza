/** Storybook stories for CollapsibleSidebarSection: expanded/collapsed, add-action, icon+indicator, and empty state. */

import type { Meta, StoryObj } from "@storybook/react";
import { Folder } from "lucide-react";
import { CollapsibleSidebarSection } from "./CollapsibleSidebarSection";

const meta = {
  title: "Shared/CollapsibleSidebarSection",
  component: CollapsibleSidebarSection,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    sectionKey: { control: "text" },
    collapsed: { control: "boolean" },
    hoverActionsOnDesktop: { control: "boolean" },
    addLabel: { control: "text" },
    emptyLabel: { control: "text" },
    testIdPrefix: { control: "text" },
  },
  args: {
    label: "Projects",
    sectionKey: "projects",
    collapsed: false,
    hoverActionsOnDesktop: true,
    onToggleCollapsed: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-64 rounded-md border border-line bg-bg p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollapsibleSidebarSection>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleChildren = (
  <ul className="space-y-1 px-2 py-1 text-sm text-txt">
    <li className="rounded-sm px-2 py-1 hover:bg-line/40">Inbox</li>
    <li className="rounded-sm px-2 py-1 hover:bg-line/40">Roadmap Q3</li>
    <li className="rounded-sm px-2 py-1 hover:bg-line/40">Design review</li>
  </ul>
);

export const Default: Story = {
  args: {
    children: sampleChildren,
  },
};

export const Collapsed: Story = {
  args: {
    collapsed: true,
    children: sampleChildren,
  },
};

export const WithAddAction: Story = {
  args: {
    addLabel: "New project",
    onAdd: () => {},
    children: sampleChildren,
  },
};

export const WithIconAndIndicator: Story = {
  args: {
    icon: <Folder className="h-3 w-3" />,
    indicator: (
      <span className="rounded-sm bg-line/60 px-1 text-[10px] font-medium text-txt">
        3
      </span>
    ),
    addLabel: "Add folder",
    onAdd: () => {},
    children: sampleChildren,
  },
};

export const EmptyState: Story = {
  args: {
    label: "Pinned",
    sectionKey: "pinned",
    emptyLabel: "Nothing pinned yet",
    emptyClassName: "px-2 py-1 text-xs text-muted italic",
    addLabel: "Pin something",
    onAdd: () => {},
  },
};
