/** Shows the context-free storage recovery surface without native writes or authentication. */
import type { Meta, StoryObj } from "@storybook/react";
import { StorageRecoveryView } from "./StorageRecoveryBoundary";

const meta = {
  title: "Shell/StorageRecovery",
  component: StorageRecoveryView,
  parameters: { layout: "fullscreen" },
  args: { busy: false, retried: false, onRetry() {}, onReload() {} },
} satisfies Meta<typeof StorageRecoveryView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unavailable: Story = {};
export const Checking: Story = { args: { busy: true } };
export const RetryFailed: Story = { args: { retried: true } };
