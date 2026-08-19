/** Presents the canonical detached resting pill and verifies its painted target. */

import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { RestingPillButton } from "./RestingPillButton";

const meta = {
  title: "Shell/RestingPillButton",
  component: RestingPillButton,
  parameters: { layout: "centered" },
  args: { "aria-label": "Open Eliza" },
} satisfies Meta<typeof RestingPillButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Resting: Story = {
  play: async ({ canvasElement }) => {
    const pill = canvasElement.querySelector("button");
    assert(
      pill instanceof HTMLButtonElement,
      "resting pill renders as a button",
    );
    const bounds = pill.getBoundingClientRect();
    assert(bounds.width === 64, "resting pill paints a 64px-wide target");
    assert(bounds.height === 44, "resting pill paints a 44px-high target");
  },
};
