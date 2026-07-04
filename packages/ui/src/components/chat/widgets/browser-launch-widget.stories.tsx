/** Storybook + story-gate visual states for the BrowserLaunchWidget. */
import type { Meta, StoryObj } from "@storybook/react";
import { BrowserLaunchWidget } from "./browser-launch-widget";

const meta = {
  title: "Chat/Widgets/BrowserLaunchWidget",
  component: BrowserLaunchWidget,
  tags: ["autodocs"],
  argTypes: {
    onLaunch: { action: "launch" },
    onCancel: { action: "cancel" },
  },
} satisfies Meta<typeof BrowserLaunchWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
  args: {
    status: "idle",
    url: "https://example.com/checkout",
    title: "Complete checkout",
    onLaunch: () => {},
    onCancel: () => {},
  },
};

export const Launching: Story = {
  args: {
    status: "launching",
    url: "https://example.com/checkout",
    title: "Complete checkout",
    message: "Opening a sandboxed browser window…",
    onLaunch: () => {},
    onCancel: () => {},
  },
};

export const Awaiting: Story = {
  args: {
    status: "awaiting",
    url: "https://example.com/login",
    title: "Sign in to continue",
    message: "Sign in in the browser, then come back here.",
    onLaunch: () => {},
    onCancel: () => {},
  },
};

export const Done: Story = {
  args: {
    status: "done",
    url: "https://example.com/order/1234",
    title: "Order confirmed",
    message: "Captured the confirmation page.",
    screenshotUrl:
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="%23222"/><text x="50%" y="50%" fill="%23bbb" font-family="sans-serif" font-size="16" text-anchor="middle" dominant-baseline="middle">Order confirmed</text></svg>',
      ),
    onLaunch: () => {},
    onCancel: () => {},
  },
};
