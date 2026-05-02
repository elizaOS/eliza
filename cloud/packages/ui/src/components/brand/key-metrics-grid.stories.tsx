import type { Meta, StoryObj } from "@storybook/react";
import { Activity, DollarSign, TrendingUp, Users } from "lucide-react";
import { KeyMetricsGrid } from "./key-metrics-grid";

const meta: Meta<typeof KeyMetricsGrid> = {
  title: "Brand/KeyMetricsGrid",
  component: KeyMetricsGrid,
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof KeyMetricsGrid>;

const sampleMetrics = [
  {
    label: "Total Requests",
    value: "12,456",
    icon: Activity,
    accent: "violet" as const,
  },
  {
    label: "Active Users",
    value: "1,892",
    icon: Users,
    accent: "emerald" as const,
  },
  {
    label: "Revenue",
    value: "$8,345",
    icon: DollarSign,
    accent: "amber" as const,
  },
  {
    label: "Growth",
    value: "+23%",
    icon: TrendingUp,
    accent: "rose" as const,
    delta: { value: "+5.2%", trend: "up" as const, label: "vs last week" },
  },
];

export const FourColumns: Story = {
  args: { metrics: sampleMetrics, columns: 4 },
};

export const ThreeColumns: Story = {
  args: { metrics: sampleMetrics.slice(0, 3), columns: 3 },
};

export const TwoColumns: Story = {
  args: { metrics: sampleMetrics.slice(0, 2), columns: 2 },
};

export const WithTrends: Story = {
  args: {
    metrics: [
      {
        label: "Revenue",
        value: "$45,231",
        icon: DollarSign,
        accent: "emerald" as const,
        delta: {
          value: "+12.5%",
          trend: "up" as const,
          label: "vs last month",
        },
      },
      {
        label: "Users",
        value: "2,341",
        icon: Users,
        accent: "violet" as const,
        delta: { value: "-3.1%", trend: "down" as const },
      },
      {
        label: "Requests",
        value: "89,123",
        icon: Activity,
        accent: "sky" as const,
        delta: { value: "0%", trend: "neutral" as const },
      },
    ],
    columns: 3,
  },
};
