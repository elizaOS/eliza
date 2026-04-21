import type { Meta, StoryObj } from "@storybook/react";
import { Stack } from "../components/ui/stack";

const meta = {
  title: "UI/Stack",
  component: Stack,
  tags: ["autodocs"],
  argTypes: {
    direction: { control: "select", options: ["row", "col"] },
    spacing: { control: "select", options: ["none", "sm", "md", "lg"] },
    align: {
      control: "select",
      options: ["start", "center", "end", "stretch", "baseline"],
    },
    justify: {
      control: "select",
      options: ["start", "center", "end", "between"],
    },
  },
} satisfies Meta<typeof Stack>;

export default meta;
type Story = StoryObj<typeof meta>;

const Box = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-md border border-border bg-bg-accent px-4 py-2 text-sm">
    {children}
  </div>
);

export const Column: Story = {
  args: { direction: "col", spacing: "md" },
  render: (args) => (
    <Stack {...args}>
      <Box>Item 1</Box>
      <Box>Item 2</Box>
      <Box>Item 3</Box>
    </Stack>
  ),
};

export const Row: Story = {
  args: { direction: "row", spacing: "md" },
  render: (args) => (
    <Stack {...args}>
      <Box>Item 1</Box>
      <Box>Item 2</Box>
      <Box>Item 3</Box>
    </Stack>
  ),
};

export const SpacingNone: Story = {
  args: { direction: "row", spacing: "none" },
  render: (args) => (
    <Stack {...args}>
      <Box>A</Box>
      <Box>B</Box>
      <Box>C</Box>
    </Stack>
  ),
};

export const SpacingSm: Story = {
  args: { direction: "row", spacing: "sm" },
  render: (args) => (
    <Stack {...args}>
      <Box>A</Box>
      <Box>B</Box>
      <Box>C</Box>
    </Stack>
  ),
};

export const SpacingLg: Story = {
  args: { direction: "row", spacing: "lg" },
  render: (args) => (
    <Stack {...args}>
      <Box>A</Box>
      <Box>B</Box>
      <Box>C</Box>
    </Stack>
  ),
};

export const AlignCenter: Story = {
  args: { direction: "row", spacing: "md", align: "center" },
  render: (args) => (
    <Stack {...args} className="h-32 border border-border p-2">
      <Box>Short</Box>
      <Box>Taller item</Box>
      <Box>Short</Box>
    </Stack>
  ),
};

export const JustifyBetween: Story = {
  args: { direction: "row", spacing: "md", justify: "between" },
  render: (args) => (
    <Stack {...args} className="w-full border border-border p-2">
      <Box>Left</Box>
      <Box>Center</Box>
      <Box>Right</Box>
    </Stack>
  ),
};
