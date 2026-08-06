/** Exhausted backend reconnect state and its explicit retry interaction. */

import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { ConnectionLostOverlay } from "./ConnectionLostOverlay";

let retryCount = 0;

const meta = {
  title: "Shell/ConnectionLostOverlay",
  component: ConnectionLostOverlay,
  parameters: { layout: "fullscreen" },
  decorators: [
    mockApp({
      backendConnection: {
        state: "failed",
        reconnectAttempt: 5,
        maxReconnectAttempts: 5,
        showDisconnectedUI: true,
      },
      retryBackendConnection: () => {
        retryCount += 1;
      },
    }),
  ],
} satisfies Meta<typeof ConnectionLostOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AttemptsExhausted: Story = {
  play: async ({ canvasElement }) => {
    retryCount = 0;
    const retry = [...canvasElement.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Retry"),
    );
    assert(retry instanceof HTMLButtonElement, "retry control is visible");
    retry.click();
    assert(retryCount === 1, "retry reaches the connection owner");
  },
};
