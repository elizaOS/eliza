import type { PermissionState } from "@elizaos/shared";
import type { Meta, StoryObj } from "@storybook/react";
import { PermissionCard } from "./permission-card";

const NOW = 1780000000000;

function stateFor(overrides: Partial<PermissionState>): PermissionState {
  return {
    id: "reminders",
    status: "not-determined",
    lastChecked: NOW,
    canRequest: true,
    platform: "darwin",
    ...overrides,
  };
}

const meta = {
  title: "Composites/Chat/PermissionCard",
  component: PermissionCard,
  tags: ["autodocs"],
  argTypes: {
    permission: {
      control: "select",
      options: [
        "reminders",
        "calendar",
        "microphone",
        "camera",
        "screen-recording",
        "accessibility",
        "location",
        "contacts",
        "full-disk",
      ],
    },
    reason: { control: "text" },
    feature: { control: "text" },
    fallbackOffered: { control: "boolean" },
    fallbackLabel: { control: "text" },
  },
  args: {
    permission: "reminders",
    reason:
      "I can add this to your Apple Reminders so it nudges you on your phone too.",
    feature: "reminders.create.add_reminder",
  },
} satisfies Meta<typeof PermissionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Fresh request — no registry wired, so the grant button stays inert. */
export const Default: Story = {};

/** Offers a fallback (use the internal reminder) alongside the grant button. */
export const WithFallback: Story = {
  args: {
    fallbackOffered: true,
    fallbackLabel: "Use internal reminder",
  },
};

/** Already denied and can't be re-prompted — surfaces "Open System Settings". */
export const Denied: Story = {
  args: {
    permission: "screen-recording",
    reason:
      "Screen recording was turned off. Re-enable it in System Settings so I can capture the window.",
    feature: "screen.capture.window",
    initialState: stateFor({
      id: "screen-recording",
      status: "denied",
      canRequest: false,
    }),
  },
};

/** Restricted by a missing entitlement — primary action is a disabled "Coming soon". */
export const ComingSoon: Story = {
  args: {
    permission: "health",
    reason: "Reading Apple Health needs an app entitlement we don't ship yet.",
    feature: "health.read.steps",
    initialState: stateFor({
      id: "health",
      status: "restricted",
      restrictedReason: "entitlement_required",
      canRequest: false,
    }),
  },
};

/** Not available on this platform — primary action is disabled "Unavailable". */
export const Unavailable: Story = {
  args: {
    permission: "screentime",
    reason: "Screen Time isn't available on this platform.",
    feature: "screentime.read.usage",
    initialState: stateFor({
      id: "screentime",
      status: "restricted",
      restrictedReason: "platform_unsupported",
      canRequest: false,
      platform: "linux",
    }),
  },
};
