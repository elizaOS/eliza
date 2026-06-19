import type { Meta, StoryObj } from "@storybook/react";
import { useEffect, useState } from "react";
import { AnimatedCounter, AnimatedCounterWithLabel } from "./animated-counter";

const meta = {
  title: "CloudUI/Monetization/AnimatedCounter",
  component: AnimatedCounter,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="bg-neutral-950 p-8 text-white min-w-[280px]">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    value: { control: { type: "number", step: 0.01 } },
    prefix: { control: "text" },
    suffix: { control: "text" },
    decimals: { control: { type: "number", min: 0, max: 6, step: 1 } },
    duration: { control: { type: "number", min: 100, step: 100 } },
  },
  args: {
    value: 1234.56,
    prefix: "$",
    suffix: "",
    decimals: 2,
    duration: 1500,
  },
} satisfies Meta<typeof AnimatedCounter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Currency: Story = {};

export const Percentage: Story = {
  args: {
    value: 87.5,
    prefix: "",
    suffix: "%",
    decimals: 1,
  },
};

export const LargeInteger: Story = {
  args: {
    value: 42891,
    prefix: "",
    suffix: " pts",
    decimals: 0,
    duration: 2000,
  },
};

export const Ticking: Story = {
  render: (args) => {
    const [value, setValue] = useState(args.value);
    useEffect(() => {
      const id = setInterval(() => {
        setValue((v) => v + Math.random() * 25);
      }, 1800);
      return () => clearInterval(id);
    }, []);
    return (
      <AnimatedCounter
        {...args}
        value={value}
        className="text-3xl font-semibold text-emerald-400"
      />
    );
  },
  args: {
    value: 250,
    prefix: "$",
    decimals: 2,
    duration: 1200,
  },
};

export const WithLabel: StoryObj<typeof AnimatedCounterWithLabel> = {
  render: (args) => <AnimatedCounterWithLabel {...args} />,
  args: {
    label: "Today's earnings",
    value: 482.91,
    prefix: "$",
    decimals: 2,
    duration: 1500,
    trend: { value: 24.18, period: "vs yesterday" },
  },
};

export const WithLabelNegativeTrend: StoryObj<typeof AnimatedCounterWithLabel> =
  {
    render: (args) => <AnimatedCounterWithLabel {...args} />,
    args: {
      label: "Account balance",
      value: 1820.44,
      prefix: "$",
      decimals: 2,
      duration: 1500,
      trend: { value: -36.12, period: "this week" },
    },
  };

export const DashboardGrid: StoryObj<typeof AnimatedCounterWithLabel> = {
  render: () => (
    <div className="grid grid-cols-3 gap-6">
      <AnimatedCounterWithLabel
        label="Revenue"
        value={12480.32}
        prefix="$"
        decimals={2}
        trend={{ value: 412.5, period: "today" }}
      />
      <AnimatedCounterWithLabel
        label="Active users"
        value={3287}
        decimals={0}
        trend={{ value: 124, period: "this week" }}
      />
      <AnimatedCounterWithLabel
        label="Churn"
        value={2.4}
        suffix="%"
        decimals={1}
        trend={{ value: -0.3, period: "this month" }}
      />
    </div>
  ),
  args: {
    label: "",
    value: 0,
  },
};
