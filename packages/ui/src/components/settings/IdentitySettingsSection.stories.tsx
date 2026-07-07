/** Storybook fixtures for `IdentitySettingsSection`: the voice-pick Basics section in its default and cloud-connected states. */

import type { Meta, StoryObj } from "@storybook/react";
import { mockApp, withMockApp } from "../../storybook/mock-providers.helpers";
import { IdentitySettingsSection } from "./IdentitySettingsSection";

const meta = {
  title: "Settings/IdentitySettingsSection",
  component: IdentitySettingsSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof IdentitySettingsSection>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default state. The voice config is fetched on mount and rejects in Storybook
 * (no backend), so the picker settles into its empty state and the save footer
 * stays idle. The agent's name and personality now live in the Character view.
 */
export const Default: Story = {};

/**
 * Eliza Cloud connected: the voice picker offers the ElevenLabs premade voice
 * groups instead of the Edge backup voices.
 */
export const CloudConnected: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: true,
    }),
  ],
};
