/** Shows purchaser states through the real SDK with an explicit local HTTP fixture. */
import type { Meta, StoryObj } from "@storybook/react";
import { AppBillingPanel } from "./AppBillingPanel";
import { billingFixture } from "./billing-fixture";

const fresh = billingFixture();
const ended = billingFixture();
ended.snapshot = {
  ...ended.snapshot,
  entitlement: {
    access: "denied",
    sourceSubscriptionRevision: "3",
    featureKeys: [],
    seatCapacity: 1,
    assignedSeats: 1,
    validUntil: "2099-01-01T00:00:00Z",
  },
  trialEligibility: {
    status: "claimed",
    startedAt: "2026-08-01T00:00:00Z",
    endsAt: "2026-08-08T00:00:00Z",
  },
};
const unavailable = billingFixture();
unavailable.failure = "read";
const meta = {
  title: "Cloud/Billing/App subscription",
  component: AppBillingPanel,
  parameters: { layout: "fullscreen" },
  args: {
    client: fresh.client,
    appId: "app-a",
    userId: "story",
    productFamilyKey: "workspace",
  },
  decorators: [
    (Story) => (
      <div className="mx-auto h-dvh w-full max-w-3xl overflow-y-auto p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof AppBillingPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Eligible: Story = {};
export const AccessEnded: Story = { args: { client: ended.client } };
export const Unavailable: Story = { args: { client: unavailable.client } };
