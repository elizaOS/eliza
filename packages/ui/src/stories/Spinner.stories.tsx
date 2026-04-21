import type { Meta, StoryObj } from "@storybook/react";
import { Spinner } from "../components/ui/spinner";

const meta = {
  title: "UI/Spinner",
  component: Spinner,
  tags: ["autodocs"],
  argTypes: {
    size: { control: "number" },
  },
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Size16: Story = {
  args: { size: 16 },
};

export const Size24: Story = {
  args: { size: 24 },
};

export const Size32: Story = {
  args: { size: 32 },
};

export const Size48: Story = {
  args: { size: 48 },
};

export const AllSizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Spinner size={16} />
      <Spinner size={24} />
      <Spinner size={32} />
      <Spinner size={48} />
    </div>
  ),
};
