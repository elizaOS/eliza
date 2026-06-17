import type { Meta, StoryObj } from "@storybook/react";
import { mockApp, withMockApp } from "../../storybook/mock-providers.helpers";
import { CloudInstancePanel } from "./CloudInstancePanel";

/**
 * `CloudInstancePanel` shows the Eliza Cloud instance-routing relay status. It
 * fetches `/api/cloud/relay-status` on mount; in Storybook there is no backend,
 * so the fetch rejects and the panel settles into its connected-but-inactive or
 * disconnected state depending on `elizaCloudConnected`.
 */
const meta = {
  title: "Settings/CloudInstancePanel",
  component: CloudInstancePanel,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "padded" },
} satisfies Meta<typeof CloudInstancePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Cloud connected: panel renders the inactive/registered relay messaging. */
export const Default: Story = {
  decorators: [mockApp({ elizaCloudConnected: true })],
};

/**
 * Not connected to Eliza Cloud — prompts the user to connect to enable instance
 * routing.
 */
export const Disconnected: Story = {
  decorators: [mockApp({ elizaCloudConnected: false })],
};
