/** Storybook states for the approval-domain canonical status adapter. */

import type { Meta, StoryObj } from "@storybook/react";
import { ApprovalStatusBadge } from "./status-badge";

const meta = {
  title: "Cloud/Approvals/ApprovalStatusBadge",
  component: ApprovalStatusBadge,
  tags: ["autodocs"],
  args: { status: "pending" },
} satisfies Meta<typeof ApprovalStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Pending: Story = {};

export const Approved: Story = {
  args: { status: "approved" },
};

export const Denied: Story = {
  args: { status: "denied" },
};

export const AwaitingSignature: Story = {
  args: { status: "delivered" },
};
