import type { Meta, StoryObj } from "@storybook/react";
import { TypingIndicator } from "./chat-typing-indicator";

const meta = {
  title: "Composites/Chat/ChatTypingIndicator",
  component: TypingIndicator,
  tags: ["autodocs"],
  argTypes: {
    agentName: { control: "text" },
    variant: { control: "select", options: ["default", "game-modal"] },
    agentAvatarSrc: { control: "text" },
    className: { control: "text" },
    dotClassName: { control: "text" },
  },
  args: { agentName: "Eliza", variant: "default" },
} satisfies Meta<typeof TypingIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const GameModal: Story = { args: { variant: "game-modal" } };

export const LongAgentName: Story = {
  args: { agentName: "Eliza Continuous Chat Assistant" },
};

export const BothVariants: Story = {
  render: (args) => (
    <div className="flex flex-col gap-6">
      <TypingIndicator {...args} variant="default" />
      <TypingIndicator {...args} variant="game-modal" />
    </div>
  ),
};
