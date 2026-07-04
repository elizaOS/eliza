/**
 * Storybook states for the ConnectionFailedBanner shell surface across
 * startup, launcher, banner, and overlay contexts.
 */
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

/**
 * The reconnecting indicator floats over page content as an overlay pill — it
 * does NOT push the content down. Regression guard for the layout shift the old
 * in-flow bar caused each time the socket blipped. The placeholder header/body
 * behind it stays exactly where it is whether or not the pill is present.
 */
export const ReconnectingOverContent: Story = {
  decorators: [
    (StoryFn) => (
      <div className="relative h-64 w-full overflow-hidden bg-bg">
        <div className="p-4 text-fg">
          <div className="mb-2 text-base font-semibold">Chat</div>
          <p className="text-sm text-fg-muted">
            This content does not move when the reconnecting pill appears — the
            pill is an absolutely-positioned overlay, not an in-flow bar.
          </p>
        </div>
        <StoryFn />
      </div>
    ),
    mockApp({
      backendConnection: {
        state: "reconnecting",
        reconnectAttempt: 4,
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
