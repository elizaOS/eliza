/** Collapsed and interactive disclosure states for assistant reasoning. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
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

export const ExpandedByUser: Story = {
  play: async ({ canvasElement }) => {
    const toggle = canvasElement.querySelector("button");
    assert(toggle instanceof HTMLButtonElement, "thinking toggle renders");
    toggle.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(toggle.getAttribute("aria-expanded") === "true", "toggle expands");
    assert(canvasElement.querySelector("pre") !== null, "reasoning is visible");
  },
};

export const EmptyReasoning: Story = { args: { reasoning: "   " } };
