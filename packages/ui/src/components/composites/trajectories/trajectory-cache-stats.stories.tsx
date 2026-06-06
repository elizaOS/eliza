import type { Meta, StoryObj } from "@storybook/react";
import { TrajectoryCacheStats } from "./trajectory-cache-stats";

const meta = {
  title: "Composites/Trajectories/TrajectoryCacheStats",
  component: TrajectoryCacheStats,
  tags: ["autodocs"],
  argTypes: {
    heading: { control: "text" },
    emptyLabel: { control: "text" },
  },
  args: {
    heading: "Cache observations",
    metrics: [
      {
        id: "hits",
        label: "Cache hits",
        value: "1,284",
        meta: "+12% vs last run",
      },
      {
        id: "misses",
        label: "Cache misses",
        value: "97",
        meta: "3 cold starts",
      },
      { id: "ratio", label: "Hit ratio", value: "93.0%" },
      { id: "savings", label: "Tokens saved", value: "412K", meta: "~$1.83" },
    ],
  },
} satisfies Meta<typeof TrajectoryCacheStats>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleMetric: Story = {
  args: {
    heading: "Prompt cache",
    metrics: [
      {
        id: "ratio",
        label: "Hit ratio",
        value: "78.4%",
        meta: "rolling 5 min",
      },
    ],
  },
};

export const NoMeta: Story = {
  args: {
    heading: "Quick stats",
    metrics: [
      { id: "in", label: "Input tokens", value: "12,840" },
      { id: "out", label: "Output tokens", value: "3,201" },
      { id: "cached", label: "Cached tokens", value: "9,002" },
    ],
  },
};

export const Empty: Story = {
  args: {
    heading: "Cache observations",
    metrics: [],
  },
};

export const EmptyCustomLabel: Story = {
  args: {
    heading: "Cache observations",
    metrics: [],
    emptyLabel: "This run did not touch the prompt cache.",
  },
};
