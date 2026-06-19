import type { Meta, StoryObj } from "@storybook/react";
import { MiniStatCard } from "./mini-stat-card";

const meta = {
  title: "CloudUI/Brand/MiniStatCard",
  component: MiniStatCard,
  tags: ["autodocs"],
  argTypes: {
    label: { control: "text" },
    value: { control: "text" },
    color: { control: "text" },
    className: { control: "text" },
  },
  args: {
    label: "Active agents",
    value: "12",
  },
} satisfies Meta<typeof MiniStatCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LargeNumber: Story = {
  args: {
    label: "Total requests",
    value: "1,284,902",
  },
};

export const Success: Story = {
  args: {
    label: "Uptime",
    value: "99.98%",
    color: "text-emerald-500",
  },
};

export const Warning: Story = {
  args: {
    label: "Errors (24h)",
    value: "37",
    color: "text-amber-500",
  },
};

export const Grid: Story = {
  render: () => (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 max-w-3xl">
      <MiniStatCard label="Active agents" value="12" />
      <MiniStatCard
        label="Requests / min"
        value="842"
        color="text-emerald-500"
      />
      <MiniStatCard label="Avg latency" value="184ms" color="text-sky-500" />
      <MiniStatCard label="Errors" value="3" color="text-rose-500" />
    </div>
  ),
};
