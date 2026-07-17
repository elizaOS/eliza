/**
 * Storybook states for the Chat Typing Indicator chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TurnStatus, TypingIndicator } from "./chat-typing-indicator";

const meta = {
  title: "Composites/Chat/ChatTypingIndicator",
  component: TypingIndicator,
  tags: ["autodocs"],
  argTypes: {
    agentName: { control: "text" },
    variant: { control: "select", options: ["default", "game-modal"] },
    className: { control: "text" },
  },
  args: {
    agentName: "Eliza",
    variant: "default",
  },
} satisfies Meta<typeof TypingIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const LongAgentName: Story = {
  args: {
    agentName: "Eliza the Helpful Assistant",
  },
};

export const GameModal: Story = {
  args: {
    variant: "game-modal",
    agentName: "Eliza",
  },
};

/** The compact neutral shimmer used by the overlay's trailing transcript row. */
export const TurnStatusThinking: Story = {
  render: () => (
    <div className="rounded-2xl bg-black/70 p-4">
      <TurnStatus status={{ kind: "thinking" }} showLabel={false} />
    </div>
  ),
};

export const TurnStatusWorking: Story = {
  render: () => (
    <div className="rounded-2xl bg-black/70 p-4">
      <TurnStatus
        status={{ kind: "running_action", actionName: "SEND_MESSAGE" }}
        showLabel={false}
      />
    </div>
  ),
};

export const TurnStatusRunningTool: Story = {
  render: () => (
    <div className="rounded-2xl bg-black/70 p-4">
      <TurnStatus
        status={{ kind: "running_tool", toolName: "WEB_SEARCH" }}
        showLabel={false}
      />
    </div>
  ),
};

export const TurnStatusSpeaking: Story = {
  render: () => (
    <div className="rounded-2xl bg-black/70 p-4">
      <TurnStatus status={{ kind: "speaking" }} showLabel={false} />
    </div>
  ),
};
