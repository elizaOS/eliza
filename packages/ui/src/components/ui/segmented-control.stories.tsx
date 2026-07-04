/**
 * Storybook stories for the segmented-control primitive (single-select button group).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { SegmentedControl } from "./segmented-control";

const items = [
  { value: "all", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

const meta = {
  title: "Primitives/SegmentedControl",
  component: SegmentedControl,
  tags: ["autodocs"],
  argTypes: {
    value: { control: "select", options: items.map((item) => item.value) },
  },
  args: { value: "all", items },
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return (
      <SegmentedControl
        {...args}
        value={value}
        onValueChange={(next) => setValue(next)}
      />
    );
  },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ActiveSelected: Story = { args: { value: "active" } };

export const WithBadges: Story = {
  args: {
    items: [
      { value: "all", label: "All", badge: "128" },
      { value: "active", label: "Active", badge: "12" },
      { value: "archived", label: "Archived", badge: "0" },
    ],
  },
};

export const WithDisabledItem: Story = {
  args: {
    items: [
      { value: "all", label: "All" },
      { value: "active", label: "Active" },
      { value: "archived", label: "Archived", disabled: true },
    ],
  },
};

export const ManyItems: Story = {
  args: {
    value: "day",
    items: [
      { value: "hour", label: "Hour" },
      { value: "day", label: "Day" },
      { value: "week", label: "Week" },
      { value: "month", label: "Month" },
      { value: "year", label: "Year" },
    ],
  },
};
