/** Storybook fixture exercising the ConfirmDialog primitive variants (default/warn/danger); also feeds the story-gate render check. */
import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { Button } from "./button";
import { ConfirmDialog } from "./confirm-dialog";

const meta = {
  title: "Primitives/ConfirmDialog",
  component: ConfirmDialog,
  tags: ["autodocs"],
  argTypes: {
    open: { control: "boolean" },
    variant: { control: "select", options: ["default", "warn", "danger"] },
    title: { control: "text" },
    message: { control: "text" },
    confirmLabel: { control: "text" },
    cancelLabel: { control: "text" },
  },
  args: {
    open: true,
    title: "Confirm",
    message: "Are you sure you want to continue?",
    confirmLabel: "Confirm",
    cancelLabel: "Cancel",
    variant: "default",
    onConfirm: () => {},
    onCancel: () => {},
  },
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Danger: Story = {
  args: {
    title: "Delete agent",
    message:
      "This permanently deletes the agent and all of its memories. This cannot be undone.",
    confirmLabel: "Delete",
    variant: "danger",
  },
};

export const Warn: Story = {
  args: {
    title: "Discard changes",
    message: "You have unsaved changes that will be lost if you leave now.",
    confirmLabel: "Discard",
    variant: "warn",
  },
};

export const MultilineMessage: Story = {
  args: {
    title: "Reset configuration",
    message:
      "This will restore default settings.\n\nYour API keys and connected plugins will be removed.",
    confirmLabel: "Reset",
    variant: "danger",
  },
};

/** Interactive trigger that opens the dialog and resolves on confirm/cancel. */
export const WithTrigger: Story = {
  render: (args) => {
    const [open, setOpen] = React.useState(false);
    return (
      <>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Delete agent
        </Button>
        <ConfirmDialog
          {...args}
          open={open}
          onConfirm={() => setOpen(false)}
          onCancel={() => setOpen(false)}
        />
      </>
    );
  },
  args: {
    open: false,
    title: "Delete agent",
    message: "This permanently deletes the agent. This cannot be undone.",
    confirmLabel: "Delete",
    variant: "danger",
  },
};
