/**
 * Storybook stories for the dashboard page container/stack.
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  DashboardPageContainer,
  DashboardPageStack,
  DashboardStatGrid,
  DashboardToolbar,
} from "./dashboard-page";

const meta = {
  title: "CloudUI/Layout/DashboardPage",
  component: DashboardPageContainer,
  tags: ["autodocs"],
  argTypes: {
    as: { control: "select", options: ["div", "main", "section"] },
    width: { control: "select", options: ["wide", "narrow", "full"] },
  },
  args: {
    width: "wide",
    as: "div",
  },
} satisfies Meta<typeof DashboardPageContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function SectionCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function ToolbarTitle() {
  return (
    <div>
      <h1 className="text-2xl font-semibold text-foreground">Overview</h1>
      <p className="text-sm text-muted-foreground">
        Monitor agents, usage, and recent activity at a glance.
      </p>
    </div>
  );
}

function ToolbarActions() {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        className="rounded-md border border-border px-3 py-1.5 text-sm"
      >
        Export
      </button>
      <button
        type="button"
        className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
      >
        New agent
      </button>
    </div>
  );
}

export const Default: Story = {
  render: (args) => (
    <DashboardPageContainer {...args}>
      <DashboardPageStack>
        <DashboardToolbar>
          <ToolbarTitle />
          <ToolbarActions />
        </DashboardToolbar>
        <DashboardStatGrid>
          <StatCard label="Active agents" value="12" />
          <StatCard label="Messages today" value="3,481" />
          <StatCard label="Tokens used" value="1.2M" />
          <StatCard label="Errors" value="3" />
        </DashboardStatGrid>
        <SectionCard
          title="Recent activity"
          body="Your agents have been busy. Tap any row to drill into details and timing."
        />
      </DashboardPageStack>
    </DashboardPageContainer>
  ),
};

export const NarrowWidth: Story = {
  args: { width: "narrow" },
  render: (args) => (
    <DashboardPageContainer {...args}>
      <DashboardPageStack>
        <DashboardToolbar>
          <ToolbarTitle />
          <ToolbarActions />
        </DashboardToolbar>
        <SectionCard
          title="Settings"
          body="A narrower container suits reading-oriented pages like settings or docs."
        />
        <SectionCard
          title="Billing"
          body="Centered, max-width-5xl — easier to scan than full-bleed dashboards."
        />
      </DashboardPageStack>
    </DashboardPageContainer>
  ),
};

export const FullBleed: Story = {
  args: { width: "full", as: "main" },
  render: (args) => (
    <DashboardPageContainer {...args}>
      <DashboardPageStack>
        <DashboardToolbar>
          <ToolbarTitle />
        </DashboardToolbar>
        <SectionCard
          title="Full-bleed surface"
          body="No max width — the content stretches to the viewport. Good for embedded grids."
        />
      </DashboardPageStack>
    </DashboardPageContainer>
  ),
};

export const ThreeColumnStats: Story = {
  render: (args) => (
    <DashboardPageContainer {...args}>
      <DashboardPageStack>
        <DashboardToolbar>
          <ToolbarTitle />
        </DashboardToolbar>
        <DashboardStatGrid columns={3}>
          <StatCard label="Requests" value="942" />
          <StatCard label="Latency p95" value="312 ms" />
          <StatCard label="Success rate" value="99.6%" />
        </DashboardStatGrid>
      </DashboardPageStack>
    </DashboardPageContainer>
  ),
};

export const TwoColumnStats: Story = {
  render: (args) => (
    <DashboardPageContainer {...args}>
      <DashboardPageStack>
        <DashboardStatGrid columns={2}>
          <StatCard label="Plan" value="Team" />
          <StatCard label="Seats" value="8 / 10" />
        </DashboardStatGrid>
      </DashboardPageStack>
    </DashboardPageContainer>
  ),
};
