/** Bounded loading state shown while a plugin registers its shell view. */
import type { Meta, StoryObj } from "@storybook/react";
import { DynamicPluginFallback } from "./DynamicPluginFallback";

const meta = {
  title: "Shell/DynamicPluginFallback",
  component: DynamicPluginFallback,
  parameters: { layout: "fullscreen" },
  args: { id: "calendar" },
} satisfies Meta<typeof DynamicPluginFallback>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {};
