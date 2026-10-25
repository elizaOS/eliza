/**
 * Storybook states for the Chat Conversation Item chat composite used by
 * shared conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ChatConversationItem } from "./chat-conversation-item";
import type { ChatConversationSummary } from "./chat-types";

const conversation: ChatConversationSummary = {
  id: "conv-1",
  title: "Planning the launch sequence",
  updatedAtLabel: "2h ago",
};

const meta = {
  title: "Composites/Chat/ChatConversationItem",
  component: ChatConversationItem,
  tags: ["autodocs"],
  argTypes: {
    variant: { control: "select", options: ["default", "game-modal"] },
    isActive: { control: "boolean" },
    isUnread: { control: "boolean" },
    mobile: { control: "boolean" },
    deleting: { control: "boolean" },
    isConfirmingDelete: { control: "boolean" },
  },
  args: {
    conversation,
    isActive: false,
    isUnread: false,
    mobile: false,
    variant: "default",
    onSelect: () => {},
    onOpenActions: () => {},
    onRequestRename: () => {},
    onRequestDeleteConfirm: () => {},
    onConfirmDelete: () => {},
    onCancelDelete: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-80 rounded-md border border-white/10 p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChatConversationItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Active: Story = { args: { isActive: true } };

export const Unread: Story = {
  args: {
    isUnread: true,
    conversation: { ...conversation, title: "New reply from the agent" },
  },
};

export const ConfirmingDelete: Story = {
  args: { isConfirmingDelete: true },
};

export const GameModal: Story = {
  args: { variant: "game-modal", isActive: true },
};
