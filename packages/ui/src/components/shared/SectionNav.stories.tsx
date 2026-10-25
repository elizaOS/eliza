/** Active, inactive, and interactive states for secondary section tabs. */
import type { Meta, StoryObj } from "@storybook/react";
import { assert } from "../../storybook/home-widget-decorator";
import { SectionNavTab } from "./SectionNav";

let selectionCount = 0;

const meta = {
  title: "Shared/SectionNavTab",
  component: SectionNavTab,
  parameters: { layout: "centered" },
  args: {
    label: "Overview",
    isActive: false,
    onSelect: () => {
      selectionCount += 1;
    },
  },
} satisfies Meta<typeof SectionNavTab>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Inactive: Story = {
  play: async ({ canvasElement }) => {
    selectionCount = 0;
    const tab = canvasElement.querySelector("button");
    assert(tab instanceof HTMLButtonElement, "section tab renders");
    tab.click();
    assert(selectionCount === 1, "inactive tab selects");
  },
};

export const Active: Story = { args: { isActive: true } };
