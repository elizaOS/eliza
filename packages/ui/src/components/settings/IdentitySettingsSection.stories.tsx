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
 * Default state. The voice config is fetched on mount and rejects in
 * Storybook (no backend), so the section settles into its empty/no-character
 * state with placeholder fields.
 */
export const Default: Story = {};

/**
 * Populated with a saved character. Name + system prompt reflect the saved
 * identity; nothing is dirty so the save footer stays idle.
 */
export const Populated: Story = {
  decorators: [
    mockApp({
      characterData: {
        name: "Ada",
        system: "You are Ada, a precise and encouraging research assistant.",
      },
      characterDraft: {
        name: "Ada",
        system: "You are Ada, a precise and encouraging research assistant.",
      },
    }),
  ],
};

/**
 * Unsaved edits: the draft diverges from the saved character, so the section
 * is dirty and the save footer becomes actionable.
 */
export const Dirty: Story = {
  decorators: [
    mockApp({
      characterData: {
        name: "Ada",
        system: "You are Ada, a precise and encouraging research assistant.",
      },
      characterDraft: {
        name: "Ada Lovelace",
        system:
          "You are Ada Lovelace, the world's first programmer. Speak with curiosity.",
      },
    }),
  ],
};

/**
 * Loading state while the initial character load is in flight.
 */
export const Loading: Story = {
  decorators: [
    mockApp({
      characterLoading: true,
    }),
  ],
};

/**
 * Eliza Cloud connected: the voice picker offers the ElevenLabs premade voice
 * groups instead of the Edge backup voices.
 */
export const CloudConnected: Story = {
  decorators: [
    mockApp({
      elizaCloudConnected: true,
      characterData: { name: "Nova", system: "You are Nova." },
      characterDraft: { name: "Nova", system: "You are Nova." },
    }),
  ],
};
