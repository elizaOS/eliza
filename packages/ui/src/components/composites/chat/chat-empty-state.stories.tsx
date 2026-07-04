/**
 * Storybook states for the Chat Empty State chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "../../ui/button";
import { ChatEmptyState } from "./chat-empty-state";

const meta = {
  title: "Composites/Chat/ChatEmptyState",
  component: ChatEmptyState,
  tags: ["autodocs"],
  argTypes: {
    agentName: { control: "text" },
    variant: { control: "select", options: ["default", "game-modal"] },
    onSuggestionClick: { action: "suggestionClicked" },
  },
  args: {
    agentName: "Eliza",
    variant: "default",
    suggestions: [
      "Hello!",
      "How are you?",
      "Tell me a joke",
      "Help me with...",
    ],
  },
} satisfies Meta<typeof ChatEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const GameModal: Story = {
  args: {
    variant: "game-modal",
    suggestions: ["Continue the quest", "Check inventory", "Talk to NPC"],
  },
};

export const CustomLabels: Story = {
  args: {
    agentName: "Aria",
    labels: {
      startConversation: "Say hi to Aria",
      sendMessageTo: "Message",
      toBeginChatting: "and she'll respond.",
    },
  },
};

export const WithActionAndHint: Story = {
  args: {
    action: <Button variant="default">Start voice chat</Button>,
    hint: "Powered by elizaOS",
  },
};

export const NoSuggestions: Story = {
  args: { suggestions: [] },
};
