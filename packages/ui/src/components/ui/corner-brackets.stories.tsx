/** Storybook fixtures showing the decorative corner primitive across its supported sizes and border modes. */
import type { Meta, StoryObj } from "@storybook/react";
import { CornerBrackets } from "./corner-brackets";

const meta = {
  title: "Primitives/CornerBrackets",
  component: CornerBrackets,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
  argTypes: {
    size: {
      control: "select",
      options: ["sm", "md", "lg", "xl"],
    },
    variant: {
      control: "select",
      options: ["corners", "full-border"],
    },
    hoverScale: { control: "boolean" },
  },
  args: {
    size: "md",
    variant: "corners",
    hoverScale: false,
  },
} satisfies Meta<typeof CornerBrackets>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Corners: Story = {
  render: (args) => (
    <div className="relative flex h-28 w-64 items-center justify-center text-accent">
      <CornerBrackets {...args} />
      <span className="text-sm font-medium text-txt">Selected agent</span>
    </div>
  ),
};

export const FullBorder: Story = {
  args: { variant: "full-border", size: "lg" },
  render: (args) => (
    <div className="relative flex h-28 w-64 items-center justify-center text-accent">
      <CornerBrackets {...args} />
      <span className="text-sm font-medium text-txt">Active workspace</span>
    </div>
  ),
};

export const SizeScale: Story = {
  render: () => (
    <div className="grid grid-cols-4 gap-6 text-accent">
      {(["sm", "md", "lg", "xl"] as const).map((size) => (
        <div
          className="relative flex size-20 items-center justify-center"
          key={size}
        >
          <CornerBrackets size={size} />
          <span className="text-xs font-medium uppercase text-txt">{size}</span>
        </div>
      ))}
    </div>
  ),
};
