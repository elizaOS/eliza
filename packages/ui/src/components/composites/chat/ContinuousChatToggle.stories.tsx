/**
 * Storybook states for the ContinuousChatToggle chat composite used by shared
 * conversation and composer surfaces.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { ContinuousChatToggle } from "./ContinuousChatToggle";

const meta = {
  title: "Composites/Chat/ContinuousChatToggle",
  component: ContinuousChatToggle,
  tags: ["autodocs"],
  argTypes: {
    value: {
      control: "inline-radio",
      options: ["off", "vad-gated", "always-on"],
    },
    disabled: { control: "boolean" },
    compact: { control: "boolean" },
    onChange: { action: "change" },
  },
  args: { value: "off", disabled: false, compact: false },
} satisfies Meta<typeof ContinuousChatToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Resting push-to-talk state — the three-segment switch with "Off" selected. */
export const Default: Story = {};

/** VAD-gated: mic opens on speech, closes on silence. */
export const VadGated: Story = { args: { value: "vad-gated" } };

/** Always-on: mic stays live; the agent decides end-of-turn. */
export const AlwaysOn: Story = { args: { value: "always-on" } };

/** Compact single-icon variant for narrow / mobile layouts. */
export const Compact: Story = { args: { compact: true, value: "vad-gated" } };

/** Disabled — no mic permission or no STT available. */
export const Disabled: Story = { args: { disabled: true, value: "always-on" } };
