/**
 * Storybook stories for the status-badge primitive (semantic status pill).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { StatusBadge } from "./status-badge";

const statusOptions = [
  "success",
  "warning",
  "danger",
  "error",
  "info",
  "neutral",
  "processing",
  "muted",
];

const meta = {
  title: "Primitives/StatusBadge",
  component: StatusBadge,
  tags: ["autodocs"],
  argTypes: {
    status: { control: "select", options: statusOptions },
    variant: { control: "select", options: statusOptions },
    tone: { control: "select", options: statusOptions },
    withDot: { control: "boolean" },
    pulse: { control: "boolean" },
    label: { control: "text" },
  },
  args: { label: "Connected", status: "success" },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Warning: Story = { args: { label: "Pending", status: "warning" } };
export const Danger: Story = { args: { label: "Failed", status: "danger" } };
export const Info: Story = { args: { label: "Syncing", status: "info" } };
export const WithDot: Story = {
  args: { label: "Online", status: "success", withDot: true },
};
export const Processing: Story = {
  args: { label: "Broadcasting", status: "processing" },
};
export const Pulsing: Story = {
  args: { label: "Live", status: "danger", pulse: true },
};

/** Every status variant in one view. */
export const AllVariants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      <StatusBadge {...args} status="success" label="Success" />
      <StatusBadge {...args} status="warning" label="Warning" />
      <StatusBadge {...args} status="danger" label="Danger" />
      <StatusBadge {...args} status="info" label="Info" />
      <StatusBadge {...args} status="processing" label="Processing" />
      <StatusBadge {...args} status="muted" label="Muted" />
    </div>
  ),
};
