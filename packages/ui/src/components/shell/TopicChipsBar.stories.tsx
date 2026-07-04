/**
 * Storybook states for the TopicChipsBar shell surface across startup,
 * launcher, banner, and overlay contexts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TopicChipsBar } from "./TopicChipsBar";

/**
 * Topic chips bar (#8928) — the channel's current topics above the transcript.
 * Rendered on the dark overlay glass, so these stories use a dark backdrop.
 */
const meta = {
  title: "Shell/TopicChipsBar",
  component: TopicChipsBar,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div
        style={{
          background:
            "radial-gradient(120% 120% at 50% 0%, #2a2233 0%, #16121c 100%)",
          padding: 16,
          borderRadius: 12,
          maxWidth: 520,
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: { onSelectTopic: () => {} },
} satisfies Meta<typeof TopicChipsBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Empty → renders nothing (no forced empty UI). */
export const Empty: Story = { args: { topics: [] } };

export const SingleTopic: Story = { args: { topics: ["billing"] } };

export const FiveTopics: Story = {
  args: {
    topics: ["billing", "auth bug", "deployment", "vacation plans", "latency"],
  },
};

export const WithActive: Story = {
  args: {
    topics: ["billing", "auth bug", "deployment", "latency"],
    activeTopic: "deployment",
  },
};

/** Overflow → the row scrolls horizontally (scrollbar hidden). */
export const Overflow: Story = {
  args: {
    topics: [
      "billing",
      "auth bug",
      "deployment",
      "vacation plans",
      "latency",
      "refunds",
      "onboarding",
      "invoices",
      "taxes",
      "incident review",
      "roadmap",
      "hiring",
    ],
  },
};
