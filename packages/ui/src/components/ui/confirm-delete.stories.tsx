/**
 * Storybook stories for the confirm-delete primitive (destructive-action confirmation trigger).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ConfirmDelete } from "./confirm-delete";

const meta = {
  title: "Primitives/ConfirmDelete",
  component: ConfirmDelete,
  tags: ["autodocs"],
  argTypes: {
    triggerLabel: { control: "text" },
    confirmLabel: { control: "text" },
    cancelLabel: { control: "text" },
    busyLabel: { control: "text" },
    promptText: { control: "text" },
    disabled: { control: "boolean" },
    onConfirm: { action: "confirmed" },
  },
  args: {
    triggerLabel: "Delete",
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    promptText: "Delete?",
    disabled: false,
    onConfirm: () => {},
  },
} satisfies Meta<typeof ConfirmDelete>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CustomLabels: Story = {
  args: {
    triggerLabel: "Remove session",
    promptText: "Remove this session?",
    confirmLabel: "Yes, remove",
    cancelLabel: "Keep",
  },
};

export const Busy: Story = {
  args: {
    disabled: true,
    busyLabel: "Deleting…",
  },
};

export const Disabled: Story = {
  args: { disabled: true },
};
