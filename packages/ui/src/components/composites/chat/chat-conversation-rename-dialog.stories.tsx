/**
 * Storybook states for the Chat Conversation Rename Dialog chat composite used
 * by shared conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ChatConversationRenameDialog } from "./chat-conversation-rename-dialog";

const meta = {
  title: "Composites/Chat/ChatConversationRenameDialog",
  component: ChatConversationRenameDialog,
  tags: ["autodocs"],
  argTypes: {
    open: { control: "boolean" },
    saving: { control: "boolean" },
    saveDisabled: { control: "boolean" },
    suggesting: { control: "boolean" },
    suggestDisabled: { control: "boolean" },
    title: { control: "text" },
    description: { control: "text" },
    inputLabel: { control: "text" },
    value: { control: "text" },
    saveLabel: { control: "text" },
    savePendingLabel: { control: "text" },
    cancelLabel: { control: "text" },
    suggestLabel: { control: "text" },
    suggestPendingLabel: { control: "text" },
    onChange: { action: "change" },
    onClose: { action: "close" },
    onSave: { action: "save" },
    onSuggest: { action: "suggest" },
  },
  args: {
    open: true,
    title: "Rename conversation",
    description: "Give this conversation a memorable title.",
    inputLabel: "Conversation title",
    value: "Weekend trip planning",
    saveLabel: "Save",
    savePendingLabel: "Saving...",
    cancelLabel: "Cancel",
    suggestLabel: "Suggest",
    suggestPendingLabel: "Thinking...",
    onChange: () => {},
    onClose: () => {},
    onSave: () => {},
  },
} satisfies Meta<typeof ChatConversationRenameDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithSuggest: Story = {
  args: {
    onSuggest: () => {},
  },
};

export const Saving: Story = {
  args: {
    saving: true,
    saveDisabled: true,
  },
};

export const Suggesting: Story = {
  args: {
    suggesting: true,
    suggestDisabled: true,
    onSuggest: () => {},
  },
};

export const EmptyValue: Story = {
  args: {
    value: "",
    saveDisabled: true,
    onSuggest: () => {},
  },
};
