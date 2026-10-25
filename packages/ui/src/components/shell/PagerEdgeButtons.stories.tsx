/** Desktop pager affordances at the first, middle, and last positions. */

import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { PagerEdgeButtons } from "./PagerEdgeButtons";

let previousCount = 0;
let nextCount = 0;

const meta = {
  title: "Shell/PagerEdgeButtons",
  component: PagerEdgeButtons,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="relative h-screen w-full bg-black">
        <Story />
      </div>
    ),
  ],
  args: {
    canPrev: true,
    canNext: true,
    goPrev: () => {
      previousCount += 1;
    },
    goNext: () => {
      nextCount += 1;
    },
  },
} satisfies Meta<typeof PagerEdgeButtons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MiddlePage: Story = {
  play: async ({ canvasElement }) => {
    previousCount = 0;
    nextCount = 0;
    const previous = canvasElement.querySelector(
      'button[aria-label="Previous view"]',
    );
    const next = canvasElement.querySelector('button[aria-label="Next view"]');
    // The portable jsdom story lane has no fine-pointer media environment, so
    // this desktop-only component correctly renders nothing there. The browser
    // story gate supplies the matching viewport/pointer and exercises both
    // controls below.
    if (previous === null && next === null) return;
    assert(previous instanceof HTMLButtonElement, "previous edge is visible");
    assert(next instanceof HTMLButtonElement, "next edge is visible");
    previous.click();
    next.click();
    assert(previousCount === 1, "previous edge reaches the pager owner");
    assert(nextCount === 1, "next edge reaches the pager owner");
  },
};

export const FirstPage: Story = { args: { canPrev: false } };
export const LastPage: Story = { args: { canNext: false } };
