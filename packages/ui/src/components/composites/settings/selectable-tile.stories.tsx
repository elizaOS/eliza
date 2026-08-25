/** Storybook states for the shared settings selection tile. */

import type { Meta, StoryObj } from "@storybook/react";
import { SelectableTile } from "./selectable-tile";

const meta = {
  title: "Composites/Settings/SelectableTile",
  component: SelectableTile,
  tags: ["autodocs"],
  args: {
    selected: false,
    label: "English",
    leading: <span className="text-base leading-none">🇺🇸</span>,
    layout: "horizontal",
    onSelect: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="grid w-48 grid-cols-1 p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SelectableTile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unselected: Story = {};

export const Selected: Story = {
  args: { selected: true },
};

export const Vertical: Story = {
  args: {
    selected: true,
    label: "Orange",
    layout: "vertical",
    leading: (
      <span className="size-5 rounded-full border border-border bg-accent" />
    ),
  },
};
