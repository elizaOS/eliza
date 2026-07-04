/**
 * Storybook stories for the dashboard table loading skeleton.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { DashboardTableSkeleton } from "./dashboard-table-skeleton";

const defaultColumns = [
  { key: "name", label: "Name" },
  { key: "status", label: "Status" },
  { key: "owner", label: "Owner" },
  { key: "updated", label: "Updated" },
] as const;

const meta = {
  title: "CloudUI/DataList/DashboardTableSkeleton",
  component: DashboardTableSkeleton,
  tags: ["autodocs"],
  argTypes: {
    rows: { control: { type: "number", min: 1, max: 12, step: 1 } },
  },
  args: {
    columns: defaultColumns,
    rows: 3,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 720, padding: 24 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DashboardTableSkeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ManyRows: Story = {
  args: {
    rows: 8,
  },
};

export const SingleRow: Story = {
  args: {
    rows: 1,
  },
};

export const CustomSkeletonWidths: Story = {
  args: {
    rows: 4,
    columns: [
      { key: "name", label: "Name", skeletonClassName: "h-4 w-40" },
      { key: "status", label: "Status", skeletonClassName: "h-4 w-16" },
      { key: "owner", label: "Owner", skeletonClassName: "h-4 w-28" },
      {
        key: "updated",
        label: "Updated",
        skeletonClassName: "h-4 w-20",
        cellClassName: "text-right",
      },
    ],
  },
};

export const TwoColumns: Story = {
  args: {
    rows: 5,
    columns: [
      { key: "label", label: "Label", skeletonClassName: "h-4 w-32" },
      { key: "value", label: "Value", skeletonClassName: "h-4 w-48" },
    ],
  },
};
