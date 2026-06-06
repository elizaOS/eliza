import type { Meta, StoryObj } from "@storybook/react";
import { TrajectoryContextDiffList } from "./trajectory-context-diff-list";

const sampleDiffs = [
  {
    id: "step-1",
    label: "Step 1 · Load user profile",
    timestampLabel: "12:04:21",
    added: "+3 entities",
    removed: "—",
    changed: "1 field",
    tokenDelta: "+412",
    description: "Fetched profile, preferences, and active goals into context.",
  },
  {
    id: "step-2",
    label: "Step 2 · Summarize prior conversation",
    timestampLabel: "12:04:23",
    added: "+1 summary",
    removed: "−18 msgs",
    changed: "—",
    tokenDelta: "−1,204",
    description: "Compressed 18 prior messages into a single rolling summary.",
  },
  {
    id: "step-3",
    label: "Step 3 · Apply tool results",
    timestampLabel: "12:04:25",
    added: "+2 facts",
    removed: "—",
    changed: "2 fields",
    tokenDelta: "+96",
  },
];

const meta = {
  title: "Composites/Trajectories/TrajectoryContextDiffList",
  component: TrajectoryContextDiffList,
  tags: ["autodocs"],
  argTypes: {
    heading: { control: "text" },
    emptyLabel: { control: "text" },
  },
  args: {
    heading: "Context diffs",
    diffs: sampleDiffs,
  },
} satisfies Meta<typeof TrajectoryContextDiffList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleStep: Story = {
  args: {
    heading: "Context diff",
    diffs: [sampleDiffs[0]],
  },
};

export const SparseMetrics: Story = {
  args: {
    heading: "Context diffs",
    diffs: [
      {
        id: "step-a",
        label: "Step A · Initial state",
        timestampLabel: "09:01:10",
        added: "+5 entities",
      },
      {
        id: "step-b",
        label: "Step B · No measurable change",
        timestampLabel: "09:01:14",
        description: "Provider returned no new facts to merge.",
      },
    ],
  },
};

export const Empty: Story = {
  args: {
    heading: "Context diffs",
    diffs: [],
  },
};

export const EmptyWithCustomLabel: Story = {
  args: {
    heading: "Context diffs",
    diffs: [],
    emptyLabel: "This trajectory ran without context mutations.",
  },
};
