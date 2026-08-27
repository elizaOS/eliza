/** Full-screen Cloud sign-in recovery surface and its retry interaction. */

import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { CloudSignInRecoveryView } from "./CloudSignInRecoveryView";

let retryCount = 0;

const meta = {
  title: "Shell/CloudSignInRecoveryView",
  component: CloudSignInRecoveryView,
  parameters: { layout: "fullscreen" },
  decorators: [withMockApp],
  args: {
    detail: "Eliza Cloud rejected the session token (401 Unauthorized).",
    onRetry: () => {
      retryCount += 1;
    },
  },
} satisfies Meta<typeof CloudSignInRecoveryView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    retryCount = 0;
    const retry = canvasElement.querySelector(
      '[data-testid="cloud-sign-in-retry"]',
    );
    assert(retry instanceof HTMLButtonElement, "retry control is rendered");
    retry.click();
    assert(retryCount === 1, "retry interaction reaches the shell owner");
  },
};
