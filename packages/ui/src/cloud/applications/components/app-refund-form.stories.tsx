/** Presents receipt review using the real SDK and controlled HTTP without issuing provider refunds. */
import type { Meta, StoryObj } from "@storybook/react";
import { catalogFixture } from "./app-catalog-fixture";
import { AppRefundForm } from "./app-refund-form";

const fixture = catalogFixture();
fixture.payments.push({
  id: "period-1",
  accountName: "Research workspace",
  planName: "Team",
  periodStart: "2026-08-01T00:00:00Z",
  periodEnd: "2026-09-01T00:00:00Z",
  quantity: 3,
  refundOperations: [
    {
      id: "refund-command",
      amountCents: 500,
      state: "receipt_available",
      createdAt: "2026-09-05T12:00:00Z",
    },
  ],
});
const meta = {
  title: "Cloud/Apps/Payment refunds",
  component: AppRefundForm,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto h-dvh w-full max-w-3xl overflow-y-auto p-6">
        <Story />
      </div>
    ),
  ],
  args: {
    client: fixture.client,
    scope: {
      appId: "app-a",
      clientRegistrationId: "client-test",
      environment: "test",
      userId: "developer-a",
    },
    disabled: false,
    onSubmit: () => undefined,
    onRecover: () => undefined,
  },
} satisfies Meta<typeof AppRefundForm>;
export default meta;
export const PaymentHistory: StoryObj<typeof meta> = {};
export const SubmissionUnavailable: StoryObj<typeof meta> = {
  args: { disabled: true },
};
