import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { ChatEmptyState } from "../components/composites/chat";

const meta = {
  title: "UI/ChatAtoms/ChatEmptyState",
  component: ChatEmptyState,
  tags: ["autodocs"],
  args: {
    agentName: "Eliza",
    onSuggestionClick: fn(),
  },
} satisfies Meta<typeof ChatEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div className="h-[400px] border border-border rounded-lg">
      <ChatEmptyState {...args} />
    </div>
  ),
};

export const CustomSuggestions: Story = {
  args: {
    agentName: "Eliza",
    suggestions: ["What can you do?", "Help me code", "Tell me about yourself"],
  },
  render: (args) => (
    <div className="h-[400px] border border-border rounded-lg">
      <ChatEmptyState {...args} />
    </div>
  ),
};
