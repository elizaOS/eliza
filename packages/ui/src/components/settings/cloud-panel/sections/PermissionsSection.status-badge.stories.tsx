/** Storybook states for the permission-domain canonical status adapter. */

import type { Meta, StoryObj } from "@storybook/react";
import { PermissionStatusBadge } from "./permission-status-badge";

const meta = {
  title: "Settings/CloudPanel/PermissionStatusBadge",
  component: PermissionStatusBadge,
  tags: ["autodocs"],
  args: { granted: true },
} satisfies Meta<typeof PermissionStatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Granted: Story = {};

export const NotGranted: Story = {
  args: { granted: false },
};
