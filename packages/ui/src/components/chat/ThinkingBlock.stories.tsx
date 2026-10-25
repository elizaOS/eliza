/** Collapsed and interactive disclosure states for assistant reasoning. */
import type { Meta, StoryObj } from "@storybook/react";
import { ThinkingBlock } from "./ThinkingBlock";

const meta = {
  title: "Chat/ThinkingBlock",
  component: ThinkingBlock,
  parameters: { layout: "padded" },
  args: {
    reasoning:
      "The calendar has one conflict, so compare the two available windows before recommending the later slot.",
  },
} satisfies Meta<typeof ThinkingBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = {};
