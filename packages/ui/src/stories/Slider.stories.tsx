import type { Meta, StoryObj } from "@storybook/react";
import { Slider } from "../components/ui/slider";

const meta = {
  title: "UI/Slider",
  component: Slider,
  tags: ["autodocs"],
  argTypes: {
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    defaultValue: [50],
    max: 100,
    step: 1,
    className: "w-64",
  },
};

export const WithRange: Story = {
  args: {
    defaultValue: [25],
    min: 0,
    max: 100,
    step: 5,
    className: "w-64",
  },
};

export const Disabled: Story = {
  args: {
    defaultValue: [40],
    max: 100,
    step: 1,
    disabled: true,
    className: "w-64",
  },
};
