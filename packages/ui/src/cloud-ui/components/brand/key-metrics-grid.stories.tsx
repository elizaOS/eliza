import type { Meta, StoryObj } from "@storybook/react";
import {
  Activity,
  CircleDollarSign,
  Sparkles,
  TrendingUp,
  Users,
  Zap,
} from "lucide-react";
import { KeyMetricsGrid } from "./key-metrics-grid";

const meta = {
  title: "CloudUI/Brand/KeyMetricsGrid",
  component: KeyMetricsGrid,
  tags: ["autodocs"],
  argTypes: {
    columns: { control: "select", options: [2, 3, 4] },
  },
} satisfies Meta<typeof KeyMetricsGrid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourColumns: Story = {
  args: {
    columns: 4,
    metrics: [
      {
        label: "Monthly revenue",
        value: "$48,210",
        icon: CircleDollarSign,
        accent: "emerald",
        delta: { value: "+12.4%", trend: "up", label: "vs last month" },
        helper: "Net of refunds and chargebacks.",
      },
      {
        label: "Active agents",
        value: "1,284",
        icon: Users,
        accent: "sky",
        delta: { value: "+86", trend: "up", label: "this week" },
      },
      {
        label: "Tasks completed",
        value: "92,431",
        icon: Activity,
        accent: "violet",
        delta: { value: "+3.1%", trend: "up" },
        helper: "Includes scheduled and on-demand runs.",
      },
      {
        label: "Avg. latency",
        value: "412 ms",
        icon: Zap,
        accent: "amber",
        delta: { value: "-18 ms", trend: "down", label: "improved" },
      },
    ],
  },
};

export const ThreeColumns: Story = {
  args: {
    columns: 3,
    metrics: [
      {
        label: "New signups",
        value: "3,402",
        icon: Sparkles,
        accent: "violet",
        delta: { value: "+22%", trend: "up", label: "WoW" },
      },
      {
        label: "Churn",
        value: "1.4%",
        accent: "rose",
        delta: { value: "+0.3%", trend: "up", label: "watch" },
        helper: "Voluntary cancellations only.",
      },
      {
        label: "Conversion",
        value: "8.7%",
        icon: TrendingUp,
        accent: "emerald",
        delta: { value: "+0.9%", trend: "up" },
      },
    ],
  },
};

export const TwoColumns: Story = {
  args: {
    columns: 2,
    metrics: [
      {
        label: "ARR",
        value: "$1.2M",
        accent: "emerald",
        delta: { value: "+18%", trend: "up", label: "YoY" },
      },
      {
        label: "Burn rate",
        value: "$84k / mo",
        accent: "amber",
        delta: { value: "-4%", trend: "down", label: "lower" },
      },
    ],
  },
};

export const MinimalNoIcons: Story = {
  args: {
    columns: 4,
    metrics: [
      { label: "Sessions", value: "12,409" },
      { label: "Avg. duration", value: "4m 12s" },
      { label: "Bounce rate", value: "32.1%" },
      { label: "Pages / session", value: "3.8" },
    ],
  },
};

export const MixedTrends: Story = {
  args: {
    columns: 3,
    metrics: [
      {
        label: "Uptime",
        value: "99.98%",
        accent: "emerald",
        delta: { value: "stable", trend: "neutral" },
      },
      {
        label: "Error rate",
        value: "0.21%",
        accent: "rose",
        delta: { value: "+0.05%", trend: "up", label: "regression" },
        helper: "P0/P1 errors across all regions.",
      },
      {
        label: "Throughput",
        value: "8.4k req/s",
        accent: "sky",
        delta: { value: "-2%", trend: "down" },
      },
    ],
  },
};
