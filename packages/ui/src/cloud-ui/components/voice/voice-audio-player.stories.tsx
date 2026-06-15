import type { Meta, StoryObj } from "@storybook/react";
import { VoiceAudioPlayer } from "./voice-audio-player";

const SAMPLE_AUDIO =
  "https://cdn.jsdelivr.net/gh/anars/blank-audio/5-seconds-of-silence.mp3";

const meta = {
  title: "CloudUI/Voice/VoiceAudioPlayer",
  component: VoiceAudioPlayer,
  tags: ["autodocs"],
  argTypes: {
    audioUrl: { control: "text" },
    className: { control: "text" },
  },
  args: {
    audioUrl: SAMPLE_AUDIO,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 520, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VoiceAudioPlayer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Compact: Story = {
  args: {
    className: "max-w-xs",
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};

export const Wide: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 800, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};

export const InCard: Story = {
  decorators: [
    (Story) => (
      <div
        style={{
          width: 560,
          padding: 16,
          borderRadius: 12,
          border: "1px solid hsl(var(--border))",
          background: "hsl(var(--card))",
        }}
      >
        <div
          style={{
            fontSize: 13,
            marginBottom: 12,
            color: "hsl(var(--muted-foreground))",
          }}
        >
          Voice memo - 2026-06-05
        </div>
        <Story />
      </div>
    ),
  ],
};

export const MissingSource: Story = {
  args: {
    audioUrl: "",
  },
};
