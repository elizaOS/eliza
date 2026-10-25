/**
 * Storybook states for the streaming permission settings card across web,
 * mobile, and voice-focused copy variants.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { StreamingPermissionsSettingsView } from "./StreamingPermissions";

/**
 * StreamingPermissionsSettingsView renders the Camera / Microphone / Screen
 * permission rows for either the web or mobile shell. The hook inside reads
 * `navigator.permissions` / `navigator.mediaDevices` (web) or the
 * `ElizaCamera` Capacitor plugin (mobile) and falls back to a "Not Set"
 * state when those APIs are absent — which is what Storybook will show.
 *
 * `t` comes from useApp(), supplied by the withMockApp decorator.
 */
const meta = {
  title: "Permissions/StreamingPermissions",
  component: StreamingPermissionsSettingsView,
  tags: ["autodocs"],
  decorators: [withMockApp],
  argTypes: {
    mode: { control: "select", options: ["web", "mobile"] },
    title: { control: "text" },
    description: { control: "text" },
    testId: { control: "text" },
  },
  args: {
    mode: "web",
    title: "Streaming permissions",
    description:
      "Let your agent access camera, microphone and screen for live tasks.",
    testId: "streaming-permissions",
  },
} satisfies Meta<typeof StreamingPermissionsSettingsView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default web mode — Camera, Microphone, and Screen rows. */
export const Web: Story = {};

/** Mobile mode hides the Screen row (screen share is web-only). */
export const Mobile: Story = {
  args: {
    mode: "mobile",
    title: "Device permissions",
    description:
      "Grant your agent access to the camera and microphone on this device.",
  },
};

/** Custom copy for a narrower onboarding context. */
export const VoiceOnly: Story = {
  args: {
    mode: "web",
    title: "Voice access",
    description:
      "Enable the microphone so your agent can hear you in voice mode.",
  },
};
