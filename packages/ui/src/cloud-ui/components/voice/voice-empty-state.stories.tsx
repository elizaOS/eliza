/**
 * Storybook stories for the VoiceEmptyState.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { VoiceEmptyState } from "./voice-empty-state";

const meta = {
  title: "CloudUI/Voice/VoiceEmptyState",
  component: VoiceEmptyState,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    onCreateClick: () => {
      // no-op handler for story
    },
  },
} satisfies Meta<typeof VoiceEmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const InContainer: Story = {
  decorators: [
    (Story) => (
      <div className="min-h-[480px] w-full rounded-lg border border-border bg-background p-8">
        <Story />
      </div>
    ),
  ],
};

export const DarkBackdrop: Story = {
  decorators: [
    (Story) => (
      <div className="dark min-h-[480px] w-full bg-zinc-950 p-8 text-foreground">
        <Story />
      </div>
    ),
  ],
};
