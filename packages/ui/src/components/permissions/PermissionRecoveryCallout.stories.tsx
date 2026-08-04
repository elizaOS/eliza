/** Permission-denial recovery with and without a retry affordance. */
import type { Meta, StoryObj } from "@storybook/react";
import { PermissionRecoveryCallout } from "./PermissionRecoveryCallout";

const meta = {
  title: "Permissions/PermissionRecoveryCallout",
  component: PermissionRecoveryCallout,
  parameters: { layout: "padded" },
  args: {
    permission: "microphone",
    title: "Microphone access is off",
    description:
      "Allow microphone access in system settings to use voice conversations.",
  },
} satisfies Meta<typeof PermissionRecoveryCallout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OpenSettingsOnly: Story = {};
export const WithRetry: Story = { args: { onRetry: async () => {} } };
