/**
 * Storybook states for the Trajectory Sidebar Item trajectory visualizer used
 * by run-detail and evidence surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TrajectorySidebarItem } from "./trajectory-sidebar-item";

function SidebarShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-80 rounded-md border border-border/40 bg-bg p-3 text-txt">
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

const meta = {
  title: "Composites/Trajectories/TrajectorySidebarItem",
  component: TrajectorySidebarItem,
  tags: ["autodocs"],
  argTypes: {
    active: { control: "boolean" },
    sourceColor: { control: "color" },
    statusColor: { control: "color" },
    title: { control: "text" },
    sourceLabel: { control: "text" },
    statusLabel: { control: "text" },
    tokenLabel: { control: "text" },
    durationLabel: { control: "text" },
    callCount: { control: "text" },
    onSelect: { action: "selected" },
  },
  args: {
    active: false,
    callCount: 12,
    title: "Daily standup recap",
    sourceLabel: "anthropic",
    sourceColor: "#d97757",
    statusLabel: "completed",
    statusColor: "#22c55e",
    tokenLabel: "4.2k tok",
    durationLabel: "1.8s",
    onSelect: () => {},
  },
  render: (args) => (
    <SidebarShell>
      <TrajectorySidebarItem {...args} />
    </SidebarShell>
  ),
} satisfies Meta<typeof TrajectorySidebarItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = {
  args: {
    active: true,
    title: "Planning the launch checklist",
    callCount: 7,
  },
};

export const Failed: Story = {
  args: {
    title: "Tool call: search_web",
    statusLabel: "failed",
    statusColor: "#ef4444",
    sourceLabel: "openai",
    sourceColor: "#10a37f",
    tokenLabel: "812 tok",
    durationLabel: "0.4s",
    callCount: 3,
  },
};

export const Streaming: Story = {
  args: {
    title: "Drafting reply to Alex",
    statusLabel: "streaming",
    statusColor: "#f97316",
    sourceLabel: "google",
    sourceColor: "#f59e0b",
    tokenLabel: "—",
    durationLabel: "live",
    callCount: 21,
  },
};

export const List: Story = {
  render: () => (
    <SidebarShell>
      <TrajectorySidebarItem
        active
        callCount={12}
        title="Daily standup recap"
        sourceLabel="anthropic"
        sourceColor="#d97757"
        statusLabel="completed"
        statusColor="#22c55e"
        tokenLabel="4.2k tok"
        durationLabel="1.8s"
        onSelect={() => {}}
      />
      <TrajectorySidebarItem
        callCount={7}
        title="Planning the launch checklist"
        sourceLabel="openai"
        sourceColor="#10a37f"
        statusLabel="completed"
        statusColor="#22c55e"
        tokenLabel="2.1k tok"
        durationLabel="0.9s"
        onSelect={() => {}}
      />
      <TrajectorySidebarItem
        callCount={3}
        title="Tool call: search_web"
        sourceLabel="openai"
        sourceColor="#10a37f"
        statusLabel="failed"
        statusColor="#ef4444"
        tokenLabel="812 tok"
        durationLabel="0.4s"
        onSelect={() => {}}
      />
    </SidebarShell>
  ),
};
