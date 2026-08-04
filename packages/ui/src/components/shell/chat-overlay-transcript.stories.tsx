/** Transcript adapter states extracted from the continuous chat overlay. */
import type { Meta, StoryObj } from "@storybook/react";
import { SpeakingStatusAccessory } from "./chat-overlay-transcript";

const meta = {
  title: "Shell/ChatOverlayTranscript",
  component: SpeakingStatusAccessory,
  parameters: { layout: "centered" },
} satisfies Meta<typeof SpeakingStatusAccessory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Speaking: Story = {};
