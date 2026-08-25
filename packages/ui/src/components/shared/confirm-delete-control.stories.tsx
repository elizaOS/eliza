/** Storybook stories for ConfirmDeleteControl: default, custom labels, ghost/outline variants, disabled, and busy state, under the shared MockAppProvider. */

import type { Meta, StoryObj } from "@storybook/react";
import type { ReactNode } from "react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ConfirmDeleteControl } from "./confirm-delete-control";

const withAppContext = (Story: () => ReactNode) => (
  <MockAppProvider>
    <div className="p-4 flex items-center gap-2 bg-background">
      <Story />
    </div>
  </MockAppProvider>
);

const meta = {
  title: "Shared/ConfirmDeleteControl",
  component: ConfirmDeleteControl,
  tags: ["autodocs"],
  decorators: [withAppContext],
  argTypes: {
    onConfirm: { action: "confirmed" },
    disabled: { control: "boolean" },
    triggerLabel: { control: "text" },
    confirmLabel: { control: "text" },
    cancelLabel: { control: "text" },
    busyLabel: { control: "text" },
    promptText: { control: "text" },
    triggerClassName: { control: "text" },
    confirmClassName: { control: "text" },
    cancelClassName: { control: "text" },
    promptClassName: { control: "text" },
    triggerTitle: { control: "text" },
    triggerVariant: {
      control: "select",
      options: ["destructive", "outline", "ghost"],
    },
  },
  args: {
    onConfirm: () => {},
    disabled: false,
    triggerClassName: "h-8 px-3",
    confirmClassName: "h-8 px-3",
    cancelClassName: "h-8 px-3",
    triggerTitle: "Delete conversation",
  },
} satisfies Meta<typeof ConfirmDeleteControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CustomLabels: Story = {
  args: {
    triggerLabel: "Remove",
    confirmLabel: "Yes, remove",
    cancelLabel: "Keep",
    promptText: "Remove this item?",
  },
};

export const GhostVariant: Story = {
  args: {
    triggerVariant: "ghost",
    triggerLabel: "Delete",
  },
};

export const OutlineVariant: Story = {
  args: {
    triggerVariant: "outline",
    triggerLabel: "Delete",
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    triggerLabel: "Delete",
  },
};

export const BusyState: Story = {
  args: {
    disabled: true,
    busyLabel: "Deleting...",
    triggerLabel: "Delete",
  },
};
