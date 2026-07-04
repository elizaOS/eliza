/**
 * Storybook states for the Sidebar Content sidebar composite across expanded,
 * collapsed, and shell navigation layouts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  SidebarContent,
  SidebarEmptyState,
  SidebarItem,
  SidebarNotice,
} from "./sidebar-content";

function SidebarShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-72 rounded-md border border-border/40 bg-bg p-4 text-txt">
      {children}
    </div>
  );
}

const meta = {
  title: "Composites/Sidebar/SidebarContent",
  component: SidebarItem,
  tags: ["autodocs"],
  argTypes: {
    active: { control: "boolean" },
    variant: {
      control: "select",
      options: ["default", "accent-soft", "dashed"],
    },
    as: { control: "select", options: ["button", "div"] },
  },
  args: {
    active: false,
    variant: "default",
    as: "button",
  },
} satisfies Meta<typeof SidebarItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SectionWithItems: Story = {
  render: () => (
    <SidebarShell>
      <SidebarContent.SectionHeader meta="3">
        <SidebarContent.SectionLabel>Conversations</SidebarContent.SectionLabel>
      </SidebarContent.SectionHeader>
      <div className="flex flex-col gap-1">
        <SidebarContent.Item active onClick={() => {}}>
          <SidebarContent.ItemIcon active>A</SidebarContent.ItemIcon>
          <SidebarContent.ItemBody>
            <SidebarContent.ItemTitle>Alpha agent</SidebarContent.ItemTitle>
            <SidebarContent.ItemDescription>
              Last reply 2 minutes ago
            </SidebarContent.ItemDescription>
          </SidebarContent.ItemBody>
        </SidebarContent.Item>
        <SidebarContent.Item onClick={() => {}}>
          <SidebarContent.ItemIcon>B</SidebarContent.ItemIcon>
          <SidebarContent.ItemBody>
            <SidebarContent.ItemTitle>Beta planner</SidebarContent.ItemTitle>
            <SidebarContent.ItemDescription>
              Drafting the agenda
            </SidebarContent.ItemDescription>
          </SidebarContent.ItemBody>
        </SidebarContent.Item>
        <SidebarContent.Item variant="dashed" onClick={() => {}}>
          <SidebarContent.ItemBody>
            <SidebarContent.ItemTitle>
              New conversation
            </SidebarContent.ItemTitle>
          </SidebarContent.ItemBody>
        </SidebarContent.Item>
      </div>
    </SidebarShell>
  ),
};

export const EmptyState: Story = {
  render: () => (
    <SidebarShell>
      <SidebarContent.SectionLabel className="mb-3">
        Pinned
      </SidebarContent.SectionLabel>
      <SidebarEmptyState>Nothing pinned yet.</SidebarEmptyState>
    </SidebarShell>
  ),
};

export const WithToolbar: Story = {
  render: () => (
    <SidebarShell>
      <SidebarContent.Toolbar className="mb-3">
        <SidebarContent.ToolbarPrimary>
          <SidebarContent.SectionLabel>Channels</SidebarContent.SectionLabel>
        </SidebarContent.ToolbarPrimary>
        <SidebarContent.ToolbarActions>
          <button
            type="button"
            onClick={() => {}}
            className="text-2xs text-muted hover:text-txt"
          >
            + New
          </button>
        </SidebarContent.ToolbarActions>
      </SidebarContent.Toolbar>
      <SidebarContent.Item variant="accent-soft" onClick={() => {}}>
        <SidebarContent.ItemBody>
          <SidebarContent.ItemTitle>#general</SidebarContent.ItemTitle>
        </SidebarContent.ItemBody>
      </SidebarContent.Item>
    </SidebarShell>
  ),
};

export const DangerNotice: Story = {
  render: () => (
    <SidebarShell>
      <SidebarNotice tone="danger">
        Connection lost. Reconnecting in 3s.
      </SidebarNotice>
    </SidebarShell>
  ),
};

export const SingleItem: Story = {
  args: {
    active: true,
    children: "Inbox",
  },
  render: (args) => (
    <SidebarShell>
      <SidebarItem {...args} />
    </SidebarShell>
  ),
};
