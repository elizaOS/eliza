import type { Meta, StoryObj } from "@storybook/react";
import { ChatMessageActions } from "./chat-message-actions";

const meta = {
  title: "Composites/Chat/ChatMessageActions",
  component: ChatMessageActions,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="relative min-h-24 w-72 rounded-md border border-border bg-card p-6">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    canDelete: { control: "boolean" },
    canEdit: { control: "boolean" },
    canPlay: { control: "boolean" },
    copied: { control: "boolean" },
    labels: { control: "object" },
    onCopy: { action: "copy" },
    onDelete: { action: "delete" },
    onEdit: { action: "edit" },
    onPlay: { action: "play" },
  },
  args: {
    canDelete: false,
    canEdit: false,
    canPlay: false,
    copied: false,
    onCopy: () => {},
    onDelete: () => {},
    onEdit: () => {},
    onPlay: () => {},
  },
} satisfies Meta<typeof ChatMessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Copied: Story = {
  args: {
    copied: true,
  },
};

export const AllActions: Story = {
  args: {
    canDelete: true,
    canEdit: true,
    canPlay: true,
  },
};

export const PlayableOnly: Story = {
  args: {
    canPlay: true,
  },
};

export const CustomLabels: Story = {
  args: {
    canDelete: true,
    canEdit: true,
    canPlay: true,
    labels: {
      copy: "Copy to clipboard",
      copied: "Copied!",
      copiedAria: "Message copied to clipboard",
      play: "Play audio",
      edit: "Edit this message",
      delete: "Remove message",
    },
  },
};
