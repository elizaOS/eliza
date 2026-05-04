import type { Meta, StoryObj } from "@storybook/react";
import { Heading, Text } from "../components/ui/typography";

const meta = {
  title: "UI/Typography",
  component: Text,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["default", "medium", "small", "muted", "lead", "large"],
    },
  },
} satisfies Meta<typeof Text>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "Default text style" },
};

export const Medium: Story = {
  args: { variant: "medium", children: "Medium text style" },
};

export const Small: Story = {
  args: { variant: "small", children: "Small text style" },
};

export const Muted: Story = {
  args: { variant: "muted", children: "Muted text style" },
};

export const Lead: Story = {
  args: { variant: "lead", children: "Lead text style" },
};

export const Large: Story = {
  args: { variant: "large", children: "Large text style" },
};

export const AllTextVariants: Story = {
  render: () => (
    <div className="space-y-2">
      <Text variant="default">Default text</Text>
      <Text variant="medium">Medium text</Text>
      <Text variant="small">Small text</Text>
      <Text variant="muted">Muted text</Text>
      <Text variant="lead">Lead text</Text>
      <Text variant="large">Large text</Text>
    </div>
  ),
};

export const HeadingH1: Story = {
  render: () => <Heading level="h1">Heading Level 1</Heading>,
};

export const HeadingH2: Story = {
  render: () => <Heading level="h2">Heading Level 2</Heading>,
};

export const HeadingH3: Story = {
  render: () => <Heading level="h3">Heading Level 3</Heading>,
};

export const HeadingH4: Story = {
  render: () => <Heading level="h4">Heading Level 4</Heading>,
};

export const HeadingH5: Story = {
  render: () => <Heading level="h5">Heading Level 5</Heading>,
};

export const HeadingH6: Story = {
  render: () => <Heading level="h6">Heading Level 6</Heading>,
};

export const AllHeadings: Story = {
  render: () => (
    <div className="space-y-4">
      <Heading level="h1">Heading 1</Heading>
      <Heading level="h2">Heading 2</Heading>
      <Heading level="h3">Heading 3</Heading>
      <Heading level="h4">Heading 4</Heading>
      <Heading level="h5">Heading 5</Heading>
      <Heading level="h6">Heading 6</Heading>
    </div>
  ),
};
