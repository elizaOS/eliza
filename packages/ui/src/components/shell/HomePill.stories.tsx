/** Idle, unavailable, open, listening, and responding shell-pill phases. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { HomePill } from "./HomePill";

let openCount = 0;

const meta = {
  title: "Shell/HomePill",
  component: HomePill,
  parameters: { layout: "centered" },
  args: {
    phase: "idle",
    onOpen: () => {
      openCount += 1;
    },
    onClose: () => {},
  },
} satisfies Meta<typeof HomePill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Idle: Story = {
  play: async ({ canvasElement }) => {
    openCount = 0;
    const pill = canvasElement.querySelector("button");
    assert(pill instanceof HTMLButtonElement, "home pill renders as a button");
    pill.click();
    assert(openCount === 1, "idle pill requests the assistant overlay");
  },
};

export const Booting: Story = { args: { phase: "booting" } };
export const Summoned: Story = { args: { phase: "summoned" } };
export const Listening: Story = { args: { phase: "listening" } };
export const Responding: Story = { args: { phase: "responding" } };
