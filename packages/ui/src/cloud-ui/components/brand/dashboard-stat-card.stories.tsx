/**
 * Storybook stories for DashboardStatCard.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { DashboardStatCard } from "./dashboard-stat-card";

const meta = {
  title: "CloudUI/Brand/DashboardStatCard",
  component: DashboardStatCard,
  tags: ["autodocs"],
  argTypes: {
    accent: {
      control: "select",
      options: ["orange", "amber", "blue", "emerald", "red", "violet", "white"],
    },
    label: { control: "text" },
    value: { control: "text" },
    helper: { control: "text" },
  },
  args: {
    label: "Active agents",
    value: "12",
    accent: "white",
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DashboardStatCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const BoltIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
  </svg>
);

export const Default: Story = {};

export const WithIconAndHelper: Story = {
  args: {
    label: "Requests today",
    value: "1,284",
    helper: "+18% vs yesterday",
    accent: "orange",
    icon: <BoltIcon />,
  },
};

export const SuccessAccent: Story = {
  args: {
    label: "Uptime",
    value: "99.98%",
    helper: "Last 30 days",
    accent: "emerald",
    icon: <BoltIcon />,
  },
};

export const WarningAccent: Story = {
  args: {
    label: "Quota usage",
    value: "82%",
    helper: "Approaching plan limit",
    accent: "amber",
    icon: <BoltIcon />,
  },
};

export const DangerAccent: Story = {
  args: {
    label: "Failed jobs",
    value: 7,
    helper: "Retry queue is backing up",
    accent: "red",
    icon: <BoltIcon />,
  },
};

export const LongValue: Story = {
  args: {
    label: "Total tokens streamed",
    value: "1,284,902,113",
    helper: "Across all workspaces",
    accent: "blue",
  },
};
