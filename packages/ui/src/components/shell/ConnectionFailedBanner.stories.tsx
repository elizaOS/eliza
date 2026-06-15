import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { ConnectionFailedBanner } from "./ConnectionFailedBanner";

// The banner reads useApp() state, not props: it returns null unless
// backendConnection exists, showDisconnectedUI is false, and the state is
// "reconnecting" or "failed". Each story forces one of those visible branches
// via mockApp({ backendConnection, ... }).
const meta = {
  title: "Shell/ConnectionFailedBanner",
  component: ConnectionFailedBanner,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConnectionFailedBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Live reconnection attempt — spinner + attempt counter. */
export const Reconnecting: Story = {
  decorators: [
    mockApp({
      backendConnection: {
        state: "reconnecting",
        reconnectAttempt: 1,
        maxReconnectAttempts: 15,
        showDisconnectedUI: false,
      },
      backendDisconnectedBannerDismissed: false,
    }),
  ],
};

/** Mid-progress reconnect — several attempts in. */
export const ReconnectingLate: Story = {
  decorators: [
    mockApp({
      backendConnection: {
        state: "reconnecting",
        reconnectAttempt: 12,
        maxReconnectAttempts: 15,
        showDisconnectedUI: false,
      },
      backendDisconnectedBannerDismissed: false,
    }),
  ],
};

/** All retries exhausted — alert banner with dismiss + retry actions. */
export const Failed: Story = {
  decorators: [
    mockApp({
      backendConnection: {
        state: "failed",
        reconnectAttempt: 15,
        maxReconnectAttempts: 15,
        showDisconnectedUI: false,
      },
      backendDisconnectedBannerDismissed: false,
    }),
  ],
};
