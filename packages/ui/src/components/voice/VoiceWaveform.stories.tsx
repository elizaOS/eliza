import type { Meta, StoryObj } from "@storybook/react";
import { VoiceWaveform } from "./VoiceWaveform";

const meta = {
  title: "Voice/VoiceWaveform",
  component: VoiceWaveform,
  tags: ["autodocs"],
  argTypes: {
    mode: {
      control: "select",
      options: ["idle", "listening", "responding"],
    },
    captureMic: { control: "boolean" },
    ariaLabel: { control: "text" },
    className: { control: "text" },
  },
  args: { mode: "idle", captureMic: false, ariaLabel: "Voice activity" },
  decorators: [
    (Story) => (
      <div className="h-40 w-80 rounded-xl bg-neutral-950 p-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VoiceWaveform>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {};

export const Listening: Story = { args: { mode: "listening" } };

export const Responding: Story = { args: { mode: "responding" } };
