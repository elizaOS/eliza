/**
 * Storybook stories for the grid layout primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Grid } from "./grid";

const Cell = ({ children }: { children: React.ReactNode }) => (
  <div className="flex items-center justify-center rounded-md bg-muted p-4 text-sm">
    {children}
  </div>
);

const cells = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return <Cell key={`cell-${n}`}>{n}</Cell>;
  });

const meta = {
  title: "Primitives/Grid",
  component: Grid,
  tags: ["autodocs"],
  argTypes: {
    columns: { control: "select", options: [1, 2, 3, 4, 6, 12] },
    spacing: { control: "select", options: ["none", "sm", "md", "lg"] },
  },
  args: { columns: 3, spacing: "md", children: cells(6) },
} satisfies Meta<typeof Grid>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const TwoColumns: Story = {
  args: { columns: 2, children: cells(4) },
};
export const FourColumns: Story = {
  args: { columns: 4, children: cells(8) },
};
export const NoSpacing: Story = {
  args: { spacing: "none" },
};
export const LargeSpacing: Story = {
  args: { spacing: "lg" },
};
