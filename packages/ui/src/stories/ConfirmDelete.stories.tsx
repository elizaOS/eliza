import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { ConfirmDelete } from "../components/ui/confirm-delete";

const meta = {
  title: "UI/ConfirmDelete",
  component: ConfirmDelete,
  tags: ["autodocs"],
  argTypes: {
    triggerLabel: { control: "text" },
    confirmLabel: { control: "text" },
    cancelLabel: { control: "text" },
    promptText: { control: "text" },
    disabled: { control: "boolean" },
  },
  args: {
    onConfirm: fn(),
  },
} satisfies Meta<typeof ConfirmDelete>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

export const CustomLabels: Story = {
  args: {
    triggerLabel: "Remove",
    confirmLabel: "Yes, remove",
    cancelLabel: "No",
    promptText: "Are you sure?",
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};
