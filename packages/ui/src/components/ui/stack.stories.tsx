/**
 * Storybook stories for the stack layout primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Stack } from "./stack";

const Box = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-md bg-muted px-4 py-2 text-sm">{children}</div>
);

const meta = {
  title: "Primitives/Stack",
  component: Stack,
  tags: ["autodocs"],
  argTypes: {
    direction: { control: "select", options: ["row", "col"] },
    align: {
      control: "select",
      options: ["start", "center", "end", "stretch", "baseline"],
    },
    justify: {
      control: "select",
      options: ["start", "center", "end", "between"],
    },
    spacing: { control: "select", options: ["none", "sm", "md", "lg"] },
  },
  args: {
    direction: "col",
    spacing: "md",
    children: (
      <>
        <Box>First</Box>
        <Box>Second</Box>
        <Box>Third</Box>
      </>
    ),
  },
} satisfies Meta<typeof Stack>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Row: Story = { args: { direction: "row" } };

export const RowCentered: Story = {
  args: { direction: "row", align: "center", justify: "center" },
};

export const SpaceBetween: Story = {
  args: { direction: "row", justify: "between" },
};

export const TightSpacing: Story = { args: { spacing: "sm" } };
