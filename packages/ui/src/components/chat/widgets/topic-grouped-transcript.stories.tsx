/** Storybook + story-gate visual states for the TopicGroupedTranscript. */
import type { Meta, StoryObj } from "@storybook/react";
import type { TopicGroup } from "./topic-grouped-transcript";
import { TopicGroupedTranscript } from "./topic-grouped-transcript";

const meta = {
  title: "Chat/Widgets/TopicGroupedTranscript",
  component: TopicGroupedTranscript,
  tags: ["autodocs"],
  argTypes: {
    onToggle: { action: "toggle" },
  },
} satisfies Meta<typeof TopicGroupedTranscript>;

export default meta;
type Story = StoryObj<typeof meta>;

const groups: TopicGroup[] = [
  {
    id: "billing",
    topic: "Billing & credits",
    messageCount: 6,
    previewLines: [
      "How do inference credits roll over?",
      "Credits reset monthly on the plan anniversary.",
      "Can I top up mid-cycle?",
    ],
  },
  {
    id: "deploys",
    topic: "Container deploys",
    messageCount: 4,
    previewLines: [
      "Deploy the worker to the cloud sandbox.",
      "Build succeeded, rolling out to one region.",
    ],
  },
  {
    id: "voice",
    topic: "Voice mode",
    messageCount: 9,
    previewLines: [
      "Switch the assistant to push-to-talk.",
      "Kokoro voice is the mobile default now.",
    ],
  },
];

export const Collapsed: Story = {
  args: {
    groups: groups.map((g) => ({ ...g, collapsed: true })),
    onToggle: () => {},
  },
};

export const Expanded: Story = {
  args: {
    groups: groups.map((g) => ({ ...g, collapsed: false })),
    onToggle: () => {},
  },
};
