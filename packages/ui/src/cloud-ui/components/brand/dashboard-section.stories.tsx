import type { Meta, StoryObj } from "@storybook/react";
import { DashboardSection } from "./dashboard-section";

const meta = {
  title: "CloudUI/Brand/DashboardSection",
  component: DashboardSection,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    title: { control: "text" },
    description: { control: "text" },
  },
  args: {
    label: "Overview",
    title: "Workspace dashboard",
    description:
      "Monitor your active agents, recent activity, and key metrics from a single place.",
  },
} satisfies Meta<typeof DashboardSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LabelOnly: Story = {
  args: {
    label: "Recent activity",
    title: undefined,
    description: undefined,
  },
};

export const WithAction: Story = {
  args: {
    label: "Deployments",
    title: "Production agents",
    description: "Six agents currently serving traffic across two regions.",
    action: (
      <button
        type="button"
        onClick={() => {}}
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
      >
        Deploy agent
      </button>
    ),
  },
};

export const RichDescription: Story = {
  args: {
    label: "Billing",
    title: "Usage this period",
    description: (
      <span>
        You have used <strong className="text-txt-strong">82%</strong> of your
        monthly request quota. Upgrade your plan to avoid throttling at the end
        of the billing cycle.
      </span>
    ),
    action: (
      <button
        type="button"
        onClick={() => {}}
        className="rounded-md border border-border px-4 py-2 text-sm font-medium text-txt-strong"
      >
        View plans
      </button>
    ),
  },
};

export const LongTitle: Story = {
  args: {
    label: "Compliance",
    title:
      "SOC 2 Type II audit readiness across all production environments and tenants",
    description:
      "Track outstanding controls, evidence collection status, and assigned owners.",
  },
};
