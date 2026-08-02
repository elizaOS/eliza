/** Fine-tuning unavailable state when the Training plugin is not installed. */
import type { Meta, StoryObj } from "@storybook/react";
import { FineTuningView } from "./injected";

const meta = {
  title: "Training/FineTuningView",
  component: FineTuningView,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof FineTuningView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PluginUnavailable: Story = {};
