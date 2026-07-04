/**
 * Storybook stories for the spinner (loading indicator) primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Spinner } from "./spinner";

const meta = {
  title: "Primitives/Spinner",
  component: Spinner,
  tags: ["autodocs"],
  argTypes: {
    size: { control: "number" },
  },
  args: { size: 24 },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Small: Story = { args: { size: 16 } };
export const Large: Story = { args: { size: 48 } };

/** Every size in one view. */
export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner size={16} />
      <Spinner size={24} />
      <Spinner size={48} />
    </div>
  ),
};
