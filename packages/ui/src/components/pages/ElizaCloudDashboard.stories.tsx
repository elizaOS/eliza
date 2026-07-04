/**
 * Storybook states for the Eliza Cloud dashboard connection, credits, billing,
 * and authentication status surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { CloudDashboard } from "./ElizaCloudDashboard";

/**
 * `CloudDashboard` reads cloud-connection + credit state from `useApp()` and
 * fetches billing details from the API on mount. In Storybook the API has no
 * backend, so the billing balance settles into its loading / empty fallback
 * while the credit summary comes from the mocked app context.
 */
const meta = {
  title: "Pages/ElizaCloudDashboard",
  component: CloudDashboard,
  parameters: { layout: "padded" },
  tags: ["autodocs"],
} satisfies Meta<typeof CloudDashboard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Not connected: the agent shows the "Connect Eliza Cloud" call to action. */
export const Disconnected: Story = {
  decorators: [mockApp({ elizaCloudConnected: false })],
};

/** Connecting: login is in flight, with a browser fallback link surfaced. */
export const Connecting: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: false,
      elizaCloudLoginBusy: true,
      elizaCloudLoginFallbackUrl: "https://cloud.eliza.how/login?cb=storybook",
    }),
  ],
};

/** Connected, healthy balance — the default overview pill. */
export const Overview: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: true,
      elizaCloudCredits: 142.5,
      elizaCloudUserId: "user_8f3c1a2b",
      cloudDashboardView: "overview",
    }),
  ],
};

/** Connected with a low balance — warning-toned credit chip. */
export const LowCredits: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: true,
      elizaCloudCredits: 3.2,
      elizaCloudCreditsLow: true,
      elizaCloudUserId: "user_8f3c1a2b",
      cloudDashboardView: "overview",
    }),
  ],
};

/** Auth rejected — danger banner plus critical credit styling. */
export const AuthRejected: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: true,
      elizaCloudCredits: 0,
      elizaCloudCreditsCritical: true,
      elizaCloudAuthRejected: true,
      elizaCloudUserId: "user_8f3c1a2b",
      cloudDashboardView: "overview",
    }),
  ],
};

/** Billing sub-view: preset top-up amounts and the auto top-up controls. */
export const BillingView: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: true,
      elizaCloudCredits: 142.5,
      elizaCloudUserId: "user_8f3c1a2b",
      cloudDashboardView: "billing",
    }),
  ],
};
