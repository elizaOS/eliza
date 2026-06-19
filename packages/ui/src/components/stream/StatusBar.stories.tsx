import type { Meta, StoryObj } from "@storybook/react";
import { mockApp } from "../../storybook/mock-providers.helpers";
import { StatusBar } from "./StatusBar";

// StatusBar shows the live/offline pill, the agent name, optional uptime +
// frame-count stats (live only), and the Go Live / Stop Stream button. It reads
// translations from useApp(); every story supplies a readable `t` via mockApp.
const statusCopy = (key: string, opts?: { defaultValue?: string }) => {
  if (key === "statusbar.LiveShort") return "LIVE";
  if (key === "statusbar.OfflineShort") return "OFFLINE";
  if (key === "statusbar.GoLive") return "Go Live";
  if (key === "statusbar.StopStream") return "Stop Stream";
  if (key === "statusbar.InstallStreamingPlugin")
    return "Install and enable the streaming plugin to go live";
  if (key === "statusbar.PopOutStreamView") return "Open in popout";
  return opts?.defaultValue ?? key;
};

const meta = {
  title: "Stream/StatusBar",
  component: StatusBar,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen" },
  decorators: [mockApp({ t: statusCopy })],
  argTypes: {
    agentName: { control: "text" },
    streamAvailable: { control: "boolean" },
    streamLive: { control: "boolean" },
    streamLoading: { control: "boolean" },
    uptime: { control: { type: "number", min: 0 } },
    frameCount: { control: { type: "number", min: 0 } },
  },
  args: {
    agentName: "Eliza",
    streamAvailable: true,
    streamLive: false,
    streamLoading: false,
    uptime: 0,
    frameCount: 0,
    onToggleStream: () => {},
  },
} satisfies Meta<typeof StatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default offline state with the streaming plugin available. */
export const Offline: Story = {};

/** Live stream — pulses the indicator, shows uptime + frame counter. */
export const Live: Story = {
  args: {
    streamLive: true,
    uptime: 3725,
    frameCount: 184_502,
  },
};

/** Streaming plugin not installed — the action button is disabled. */
export const StreamUnavailable: Story = {
  args: {
    streamAvailable: false,
  },
};

/** Mid-toggle: the button shows the loading placeholder and is disabled. */
export const Loading: Story = {
  args: {
    streamLoading: true,
  },
};

/** Long agent name to stress the layout. */
export const LongAgentName: Story = {
  args: {
    agentName: "Eliza — Personal Operations Assistant (Prod)",
    streamLive: true,
    uptime: 42,
    frameCount: 1200,
  },
};
