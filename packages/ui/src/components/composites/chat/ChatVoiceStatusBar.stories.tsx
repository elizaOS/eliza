/**
 * Storybook states for the ChatVoiceStatusBar chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ChatVoiceStatusBar } from "./ChatVoiceStatusBar";

const meta = {
  title: "Composites/Chat/ChatVoiceStatusBar",
  component: ChatVoiceStatusBar,
  tags: ["autodocs"],
  argTypes: {
    status: {
      control: "select",
      options: ["idle", "listening", "thinking", "speaking", "interrupting"],
    },
    interimTranscript: { control: "text" },
    ownerEntityId: { control: "text" },
    visible: { control: "boolean" },
  },
  args: {
    status: "listening",
    interimTranscript: "what's the weather looking like tomorrow",
    speaker: { entityId: "user-42", name: "Nubs", source: "browser" },
    ownerEntityId: null,
    latency: {
      speechEndToFirstTokenMs: 210,
      speechEndToVoiceStartMs: 380,
      assistantStreamToVoiceStartMs: 120,
      firstSegmentCached: false,
    },
    visible: true,
  },
} satisfies Meta<typeof ChatVoiceStatusBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Thinking: Story = {
  args: {
    status: "thinking",
    interimTranscript: "",
    latency: {
      speechEndToFirstTokenMs: 940,
      speechEndToVoiceStartMs: 1320,
      assistantStreamToVoiceStartMs: 380,
      firstSegmentCached: false,
    },
  },
};

export const OwnerSpeakingCached: Story = {
  args: {
    status: "speaking",
    interimTranscript: "",
    speaker: { entityId: "owner-1", name: "Eliza", source: "talkmode" },
    ownerEntityId: "owner-1",
    latency: {
      speechEndToFirstTokenMs: 120,
      speechEndToVoiceStartMs: 240,
      assistantStreamToVoiceStartMs: 90,
      firstSegmentCached: true,
    },
  },
};

export const InterruptingHighLatency: Story = {
  args: {
    status: "interrupting",
    interimTranscript: "actually wait, cancel that",
    speaker: { entityId: "user-42", name: "Nubs", source: "browser" },
    latency: {
      speechEndToFirstTokenMs: 1800,
      speechEndToVoiceStartMs: 2400,
      assistantStreamToVoiceStartMs: 600,
      firstSegmentCached: false,
    },
  },
};

export const Idle: Story = {
  args: {
    status: "idle",
    interimTranscript: "",
    speaker: null,
    latency: {
      speechEndToFirstTokenMs: null,
      speechEndToVoiceStartMs: null,
      assistantStreamToVoiceStartMs: null,
      firstSegmentCached: null,
    },
  },
};
