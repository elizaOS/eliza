import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { SegmentedControl } from "../index";

const meta = {
  title: "Composites/SegmentedControl",
  component: SegmentedControl,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof SegmentedControl>;

export default meta;
type Story = StoryObj<typeof meta>;

function SegmentedDemo() {
  const [value, setValue] = useState("table");
  return (
    <SegmentedControl
      value={value}
      onValueChange={setValue}
      items={[
        { value: "table", label: "Table" },
        { value: "sql", label: "SQL" },
        { value: "chart", label: "Chart" },
      ]}
    />
  );
}

export const Default: Story = {
  render: () => <SegmentedDemo />,
};

function WithBadges() {
  const [value, setValue] = useState("all");
  return (
    <SegmentedControl
      value={value}
      onValueChange={setValue}
      items={[
        {
          value: "all",
          label: "All",
          badge: (
            <span className="ml-1 rounded-full bg-accent/20 px-1.5 text-2xs text-accent">
              42
            </span>
          ),
        },
        { value: "active", label: "Active" },
        { value: "archived", label: "Archived", disabled: true },
      ]}
    />
  );
}

export const WithBadgesAndDisabled: Story = {
  render: () => <WithBadges />,
};
