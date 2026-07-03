import type { Meta, StoryObj } from "@storybook/react";
import { TypingIndicator } from "./chat-typing-indicator";

const meta = {
  title: "Composites/Chat/ChatTypingIndicator",
  component: TypingIndicator,
  tags: ["autodocs"],
  argTypes: {
    agentName: { control: "text" },
    agentAvatarSrc: { control: "text" },
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

export const WithAvatar: Story = {
  args: {
    agentName: "Eliza",
    agentAvatarSrc: "https://placehold.co/40x40/png?text=E",
  },
};
