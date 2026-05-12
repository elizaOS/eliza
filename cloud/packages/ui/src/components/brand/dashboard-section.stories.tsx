import type { Meta, StoryObj } from "@storybook/react";
import { DashboardSection } from "./dashboard-section";

const meta: Meta<typeof DashboardSection> = {
  title: "Brand/DashboardSection",
  component: DashboardSection,
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 800, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof DashboardSection>;

export const LabelOnly: Story = {
  args: { label: "Overview" },
};

export const WithTitle: Story = {
  args: { label: "Analytics", title: "App Performance" },
};

export const WithDescription: Story = {
  args: {
    label: "Settings",
    title: "API Keys",
    description: "Manage your API keys and access tokens for programmatic access.",
  },
};

export const WithAction: Story = {
  args: {
    label: "Containers",
    title: "Active Deployments",
    description: "View and manage your running containers.",
    action: (
      <button
        style={{
          padding: "8px 16px",
          background: "#FF5800",
          color: "white",
          border: "none",
          cursor: "pointer",
        }}
      >
        Deploy New
      </button>
    ),
  },
};
