import type { Meta, StoryObj } from "@storybook/react";
import { CheckCircle2 } from "lucide-react";
import { StatusBadge } from "./status-badge";

const meta: Meta<typeof StatusBadge> = {
  title: "Components/StatusBadge",
  component: StatusBadge,
};
export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Success: Story = {
  args: { status: "success", label: "Ready" },
};

export const SuccessWithIcon: Story = {
  args: {
    status: "success",
    label: "Connected",
    icon: <CheckCircle2 />,
  },
};

export const Warning: Story = {
  args: { status: "warning", label: "Finalizing" },
};

export const Error: Story = {
  args: { status: "error", label: "Failed" },
};

export const Processing: Story = {
  args: { status: "processing", label: "Processing" },
};

export const WithPulse: Story = {
  args: { status: "success", label: "Online", pulse: true },
};

export const Neutral: Story = {
  args: { status: "neutral", label: "Inactive" },
};
