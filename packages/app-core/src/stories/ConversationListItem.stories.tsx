import type { Meta, StoryObj } from "@storybook/react";
import { createRef } from "react";
import { ConversationListItem } from "../components/conversations/ConversationListItem";

const noop = () => {};

const meta: Meta<typeof ConversationListItem> = {
  title: "Chat/ConversationListItem",
  component: ConversationListItem,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ConversationListItem>;

const baseProps = {
  conv: {
    id: "conv-1",
    title: "Hello World",
    updatedAt: new Date().toISOString(),
  },
  isActive: false,
  isEditing: false,
  isUnread: false,
  isGameModal: false,
  editingTitle: "",
  confirmDeleteId: null,
  deletingId: null,
  inputRef: createRef<HTMLInputElement>(),
  t: (k: string) => k,
  mobile: false,
  onSelect: noop,
  onEditingTitleChange: noop,
  onEditSubmit: noop,
  onEditKeyDown: noop,
  onConfirmDelete: noop,
  onCancelDelete: noop,
  onOpenActions: noop,
};

export const Default: Story = {
  render: () => (
    <div
      style={{
        width: 260,
        border: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <ConversationListItem {...baseProps} />
    </div>
  ),
};

export const Active: Story = {
  render: () => (
    <div
      style={{
        width: 260,
        border: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <ConversationListItem {...baseProps} isActive />
    </div>
  ),
};

export const Unread: Story = {
  render: () => (
    <div
      style={{
        width: 260,
        border: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <ConversationListItem {...baseProps} isUnread />
    </div>
  ),
};

export const ConfirmDelete: Story = {
  render: () => (
    <div
      style={{
        width: 320,
        border: "1px solid var(--border)",
        background: "var(--bg)",
      }}
    >
      <ConversationListItem {...baseProps} confirmDeleteId="conv-1" />
    </div>
  ),
};

export const GameModal: Story = {
  render: () => (
    <div style={{ width: 280 }}>
      <ConversationListItem {...baseProps} isGameModal />
    </div>
  ),
};
