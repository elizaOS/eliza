/** Hardware-tier copy and compact rendering for local versus cloud voice. */
import type { Meta, StoryObj } from "@storybook/react";
import { VoiceTierBanner } from "./VoiceTierBanner";

const meta = {
  title: "Settings/VoiceTierBanner",
  component: VoiceTierBanner,
  parameters: { layout: "padded" },
  args: { tier: "GOOD", summary: "16 GB RAM · 8 cores · Apple Silicon" },
} satisfies Meta<typeof VoiceTierBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Good: Story = {};
export const Maximum: Story = { args: { tier: "MAX" } };
export const Okay: Story = { args: { tier: "OKAY" } };
export const CloudFallback: Story = { args: { tier: "POOR" } };
export const Compact: Story = { args: { compact: true } };
