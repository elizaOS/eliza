/**
 * Storybook stories for the skeleton-layout primitives (list/detail/table loading placeholders).
 */
import type { Meta, StoryObj } from "@storybook/react";
import {
  DetailSkeleton,
  ListSkeleton,
  TableSkeleton,
} from "./skeleton-layouts";

const meta = {
  title: "Primitives/SkeletonLayouts",
  component: ListSkeleton,
  tags: ["autodocs"],
  argTypes: {
    rows: { control: { type: "number", min: 0, max: 20 } },
    rowClassName: { control: "text" },
    className: { control: "text" },
  },
  args: { rows: 6 },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ListSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {};

export const ShortList: Story = { args: { rows: 3 } };

/** Header row plus a grid of cells — for database / query result views. */
export const Table: Story = {
  render: () => <TableSkeleton rows={6} columns={4} />,
};

/** Title, a few text lines, and a content block — for detail panels. */
export const Detail: Story = {
  render: () => <DetailSkeleton />,
};

/** All three layouts side by side. */
export const AllLayouts: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <ListSkeleton rows={4} />
      <TableSkeleton rows={4} columns={3} />
      <DetailSkeleton />
    </div>
  ),
};
