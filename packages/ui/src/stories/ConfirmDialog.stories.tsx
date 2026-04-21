import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { ConfirmDialog, PromptDialog } from "../components/ui/confirm-dialog";

const meta = {
  title: "UI/ConfirmDialog",
  component: ConfirmDialog,
  tags: ["autodocs"],
  argTypes: {
    open: { control: "boolean" },
    title: { control: "text" },
    message: { control: "text" },
    confirmLabel: { control: "text" },
    cancelLabel: { control: "text" },
    variant: {
      control: "select",
      options: ["default", "danger", "warn"],
    },
  },
  args: {
    onConfirm: fn(),
    onCancel: fn(),
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    open: true,
    title: "Confirm Action",
    message: "Are you sure you want to proceed?",
  },
};

export const Danger: Story = {
  args: {
    open: true,
    title: "Delete Item",
    message:
      "This action cannot be undone. All data will be permanently removed.",
    confirmLabel: "Delete",
    variant: "danger",
  },
};

export const Warn: Story = {
  args: {
    open: true,
    title: "Unsaved Changes",
    message: "You have unsaved changes. Do you want to leave without saving?",
    confirmLabel: "Leave",
    variant: "warn",
  },
};

export const Prompt: Story = {
  render: () => (
    <PromptDialog
      open={true}
      title="Rename Agent"
      message="Enter a new name for the agent."
      placeholder="Agent name"
      defaultValue="Eliza"
      onConfirm={fn()}
      onCancel={fn()}
    />
  ),
};
