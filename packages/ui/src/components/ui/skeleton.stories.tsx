import type { Meta, StoryObj } from "@storybook/react";
import { Skeleton } from "./skeleton";

const meta = {
  title: "Primitives/Skeleton",
  component: Skeleton,
  tags: ["autodocs"],
  argTypes: {
    className: { control: "text" },
  },
  args: { className: "h-4 w-48" },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Line: Story = { args: { className: "h-4 w-64" } };

export const Circle: Story = { args: { className: "h-12 w-12 rounded-full" } };

export const Block: Story = { args: { className: "h-32 w-64" } };

/** Composed placeholder approximating a loading card. */
export const Card: Story = {
  render: () => (
    <div className="flex w-72 flex-col gap-3">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  ),
};

/** Avatar with adjacent text lines, e.g. a loading list row. */
export const Row: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Skeleton className="h-12 w-12 rounded-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  ),
};
