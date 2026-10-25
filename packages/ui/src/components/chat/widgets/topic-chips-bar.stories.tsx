/**
 * Storybook states for the Topic Chips Bar chat widget across populated,
 * empty, and interaction-focused render states.
 */
import type { Meta, StoryObj } from "@storybook/react";
import type { TopicChip } from "./topic-chips-bar";
import { TopicChipsBar } from "./topic-chips-bar";

const meta = {
  title: "Chat/Widgets/TopicChipsBar",
  component: TopicChipsBar,
  tags: ["autodocs"],
  argTypes: {
    onSelect: { action: "select" },
  },
} satisfies Meta<typeof TopicChipsBar>;

export default meta;
type Story = StoryObj<typeof meta>;

function chips(count: number): TopicChip[] {
  const labels = [
    "Onboarding",
    "Billing",
    "Deploys",
    "Voice mode",
    "Plugins",
    "Memory",
    "Scheduling",
    "Connectors",
    "Models",
    "Security",
    "Skills",
    "Roadmap",
  ];
  return Array.from({ length: count }, (_, i) => ({
    id: `topic-${i}`,
    label: labels[i % labels.length],
    count: ((i * 3 + 1) % 9) + 1,
  }));
}

export const Empty: Story = {
  args: {
    topics: [],
    onSelect: () => {},
  },
};

export const Single: Story = {
  args: {
    topics: chips(1),
    activeTopicId: "topic-0",
    onSelect: () => {},
  },
};

export const Few: Story = {
  args: {
    topics: chips(5),
    activeTopicId: "topic-1",
    onSelect: () => {},
  },
};

export const Overflow: Story = {
  args: {
    topics: chips(12),
    activeTopicId: "topic-0",
    maxVisible: 6,
    onSelect: () => {},
  },
};
