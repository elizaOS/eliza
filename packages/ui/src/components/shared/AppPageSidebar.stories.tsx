/** Storybook stories for AppPageSidebar: default/collapsible/header+action/mobile variants over a stub nav list. */

import type { Meta, StoryObj } from "@storybook/react";
import { AppPageSidebar } from "./AppPageSidebar";

const navItems = ["Overview", "Activity", "Members", "Settings"];

function NavList() {
  return (
    <nav className="flex flex-col gap-1 px-2 py-2 text-sm">
      {navItems.map((label) => (
        <button
          key={label}
          type="button"
          className="rounded-sm px-2 py-1.5 text-left text-muted transition-colors hover:bg-card hover:text-txt"
        >
          {label}
        </button>
      ))}
    </nav>
  );
}

const meta = {
  title: "Shared/AppPageSidebar",
  component: AppPageSidebar,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "game-modal", "mobile"],
    },
    collapsible: { control: "boolean" },
    collapsed: { control: "boolean" },
    resizable: { control: "boolean" },
    defaultWidth: { control: "number" },
  },
  args: {
    variant: "default",
    contentIdentity: "demo-page",
    children: <NavList />,
  },
  decorators: [
    (Story) => (
      <div style={{ height: 420, display: "flex" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppPageSidebar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Collapsible: Story = {
  args: { collapsible: true },
};

export const WithHeaderAndAction: Story = {
  args: {
    collapsible: true,
    header: (
      <div className="px-2 py-2 text-xs font-medium uppercase tracking-wide text-muted">
        Workspace
      </div>
    ),
    bottomAction: (
      <button
        type="button"
        className="rounded-sm px-2 py-1 text-xs text-muted hover:text-txt"
      >
        New
      </button>
    ),
  },
};

export const Mobile: Story = {
  args: {
    variant: "mobile",
    mobileTitle: "Workspace",
  },
};
