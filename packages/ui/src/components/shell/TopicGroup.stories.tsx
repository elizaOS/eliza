/**
 * Storybook states for the TopicGroup shell surface across startup, launcher,
 * banner, and overlay contexts.
 */
import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { TopicGroup } from "./TopicGroup";

/**
 * Collapsible topic cluster (#8928). Header is gesture-driven (tap / flick —
 * no visible buttons): expanded shows a quiet topic divider over the messages;
 * collapsed shows a single pill ("● topic — N messages").
 */
const meta = {
  title: "Shell/TopicGroup",
  component: TopicGroup,
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
          color: "white",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TopicGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

function Bubbles({ lines }: { lines: string[] }): React.JSX.Element {
  return (
    <>
      {lines.map((line) => (
        <div
          key={line}
          className="mb-2 whitespace-pre-wrap text-[13px] leading-relaxed text-white/80"
        >
          {line}
        </div>
      ))}
    </>
  );
}

/** A live wrapper so the gesture/tap toggling is interactive in the story. */
function InteractiveTopicGroup({
  topic,
  lines,
  initialCollapsed,
}: {
  topic: string;
  lines: string[];
  initialCollapsed: boolean;
}): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  return (
    <TopicGroup
      topic={topic}
      count={lines.length}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    >
      <Bubbles lines={lines} />
    </TopicGroup>
  );
}

export const Expanded: Story = {
  render: () => (
    <InteractiveTopicGroup
      topic="deployment"
      initialCollapsed={false}
      lines={[
        "Can you deploy the worker?",
        "Deploying now — building the image…",
        "Done. The provisioning worker is live.",
      ]}
    />
  ),
};

export const Collapsed: Story = {
  render: () => (
    <InteractiveTopicGroup
      topic="deployment"
      initialCollapsed
      lines={Array.from(
        { length: 12 },
        (_, i) => `deployment message ${i + 1}`,
      )}
    />
  ),
};

/** Two adjacent groups: one expanded, one collapsed — tap a header to toggle. */
export const Mixed: Story = {
  render: () => (
    <div>
      <InteractiveTopicGroup
        topic="billing"
        initialCollapsed={false}
        lines={["What's my invoice total?", "Your October invoice is $420."]}
      />
      <InteractiveTopicGroup
        topic="deployment"
        initialCollapsed
        lines={Array.from(
          { length: 8 },
          (_, i) => `deployment message ${i + 1}`,
        )}
      />
    </div>
  ),
};
