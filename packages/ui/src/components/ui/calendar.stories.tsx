import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Calendar } from "./calendar";

const meta = {
  title: "Primitives/Calendar",
  component: Calendar,
  tags: ["autodocs"],
  argTypes: {
    showOutsideDays: { control: "boolean" },
    captionLayout: {
      control: "select",
      options: ["label", "dropdown", "dropdown-months", "dropdown-years"],
    },
    buttonVariant: {
      control: "select",
      options: ["default", "outline", "secondary", "ghost", "link"],
    },
  },
  args: {
    showOutsideDays: true,
    captionLayout: "label",
    buttonVariant: "ghost",
  },
} satisfies Meta<typeof Calendar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {
  render: (args) => {
    const [selected, setSelected] = useState<Date | undefined>(new Date());
    return (
      <Calendar
        {...args}
        mode="single"
        selected={selected}
        onSelect={setSelected}
      />
    );
  },
};

export const Range: Story = {
  render: (args) => {
    const [range, setRange] = useState<DateRange | undefined>({
      from: new Date(2026, 5, 8),
      to: new Date(2026, 5, 14),
    });
    return (
      <Calendar {...args} mode="range" selected={range} onSelect={setRange} />
    );
  },
};

export const DropdownNav: Story = {
  args: { captionLayout: "dropdown" },
  render: (args) => {
    const [selected, setSelected] = useState<Date | undefined>(new Date());
    return (
      <Calendar
        {...args}
        mode="single"
        selected={selected}
        onSelect={setSelected}
      />
    );
  },
};

export const DisabledDates: Story = {
  render: (args) => {
    const [selected, setSelected] = useState<Date | undefined>();
    return (
      <Calendar
        {...args}
        mode="single"
        selected={selected}
        onSelect={setSelected}
        disabled={{ dayOfWeek: [0, 6] }}
      />
    );
  },
};
