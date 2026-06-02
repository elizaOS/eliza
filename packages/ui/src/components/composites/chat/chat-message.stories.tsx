import type { Meta, StoryObj } from "@storybook/react";
import { ChatMessage } from "./chat-message";

const meta = {
  title: "Composites/Chat/ChatMessage",
  component: ChatMessage,
  tags: ["autodocs"],
  argTypes: {
    agentName: { control: "text" },
    isGrouped: { control: "boolean" },
    userMessagesOnRight: { control: "boolean" },
  },
  args: {
    agentName: "Eliza",
    isGrouped: false,
    userMessagesOnRight: true,
    onCopy: () => {},
    message: {
      id: "msg-assistant-1",
      role: "assistant",
      text: "Hey, I pulled the latest metrics for you. Want me to walk through the highlights?",
    },
  },
} satisfies Meta<typeof ChatMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Assistant: Story = {};

export const User: Story = {
  args: {
    message: {
      id: "msg-user-1",
      role: "user",
      text: "Yes please, start with the engagement numbers.",
      from: "Nubs",
      fromUserName: "nubscarson",
    },
  },
};

export const Interrupted: Story = {
  args: {
    message: {
      id: "msg-assistant-2",
      role: "assistant",
      text: "Engagement is up 12% week over week, mostly driven by the new",
      interrupted: true,
    },
  },
};

export const WithReactions: Story = {
  args: {
    message: {
      id: "msg-assistant-3",
      role: "assistant",
      text: "Done. The report is ready whenever you want to review it.",
      reactions: [
        { emoji: "👍", count: 3, users: ["Nubs", "Ada", "Lin"] },
        { emoji: "🚀", count: 1, users: ["Nubs"] },
      ],
    },
  },
};

export const Editable: Story = {
  args: {
    message: {
      id: "msg-user-2",
      role: "user",
      text: "Can you also break it down by channel?",
      from: "Nubs",
      fromUserName: "nubscarson",
    },
    onEdit: () => true,
    onDelete: () => {},
  },
};
