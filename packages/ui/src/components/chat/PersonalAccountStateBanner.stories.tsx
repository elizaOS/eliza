/**
 * Storybook states for the personal Eliza fallback banner shown above the chat
 * composer while Dedicated access is withdrawn or the route is between
 * runtimes (#25146).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { createTranslator } from "../../i18n";
import { PersonalFallbackBannerView } from "./PersonalAccountStateBanner";

const t = createTranslator("en");
const cloudApiBase = "https://api.elizacloud.ai";

const meta = {
  title: "Chat/PersonalFallbackBanner",
  component: PersonalFallbackBannerView,
  tags: ["autodocs"],
  args: { t, locale: "en-US", view: { status: "idle" } },
  decorators: [
    (Story) => (
      <div className="max-w-2xl">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PersonalFallbackBannerView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PaymentFailed: Story = {
  args: {
    view: {
      status: "shared_fallback",
      cloudApiBase,
      accountState: {
        access: "shared_fallback",
        state: "shared_active",
        reason: "subscription_payment_failed",
        dedicatedMemory: "unavailable",
        generation: 2,
        dedicatedRetainedUntil: "2026-10-27T00:00:00.000Z",
        recoveryAction: {
          kind: "restore_subscription",
          path: "/cloud/billing",
        },
      },
    },
  },
};

export const OutOfCredits: Story = {
  args: {
    view: {
      status: "shared_fallback",
      cloudApiBase,
      accountState: {
        access: "shared_fallback",
        state: "shared_active",
        reason: "billing_suspended",
        dedicatedMemory: "unavailable",
        generation: 1,
        dedicatedRetainedUntil: null,
        recoveryAction: { kind: "add_credits", path: "/cloud/billing" },
      },
    },
  },
};

export const RecoveryPending: Story = {
  args: {
    view: {
      status: "shared_fallback",
      cloudApiBase,
      accountState: {
        access: "shared_fallback",
        state: "recovery_pending",
        reason: "subscription_ended",
        dedicatedMemory: "unavailable",
        generation: 4,
        dedicatedRetainedUntil: "2026-10-27T00:00:00.000Z",
        recoveryAction: {
          kind: "restore_subscription",
          path: "/cloud/billing",
        },
      },
    },
  },
};

export const Reconciling: Story = {
  args: {
    view: {
      status: "retrying",
      code: "dedicated_reconciling",
      retryAfterSeconds: null,
    },
  },
};
