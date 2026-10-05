/** Presents app account records using the SDK HTTP fixture, including authoritative empty results. */
import type { Meta, StoryObj } from "@storybook/react";
import { AppBillingRecords } from "./AppBillingRecords";
import { billingFixture } from "./billing-fixture";

const fixture = billingFixture();
const meta = {
  title: "Cloud/Billing/App records",
  component: AppBillingRecords,
  args: {
    client: fixture.client,
    accountId: "account-1",
    productFamilyKey: "workspace",
    administrator: true,
  },
} satisfies Meta<typeof AppBillingRecords>;
export default meta;
export const Empty: StoryObj<typeof meta> = {};
