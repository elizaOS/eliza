/**
 * Storybook stories for the typography primitives (Heading and Text).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Heading, Text } from "./typography";

const meta = {
  title: "Primitives/Typography",
  component: Text,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "medium", "small", "muted", "lead", "large"],
    },
    children: { control: "text" },
  },
  args: {
    children: "The quick brown fox jumps over the lazy dog.",
    variant: "default",
  },
} satisfies Meta<typeof Text>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Muted: Story = {
  args: { variant: "muted", children: "Secondary, lower-emphasis copy." },
};
export const Lead: Story = {
  args: { variant: "lead", children: "A leading paragraph that sets context." },
};
export const Large: Story = {
  args: { variant: "large", children: "Large emphasis text" },
};

/** Every Text variant in one view. */
export const AllTextVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Text variant="lead">Lead</Text>
      <Text variant="large">Large</Text>
      <Text variant="default">Default</Text>
      <Text variant="medium">Medium</Text>
      <Text variant="small">Small</Text>
      <Text variant="muted">Muted</Text>
    </div>
  ),
};

/** Every Heading level in one view. */
export const Headings: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <Heading level="h1">Heading h1</Heading>
      <Heading level="h2">Heading h2</Heading>
      <Heading level="h3">Heading h3</Heading>
      <Heading level="h4">Heading h4</Heading>
      <Heading level="h5">Heading h5</Heading>
      <Heading level="h6">Heading h6</Heading>
    </div>
  ),
};
