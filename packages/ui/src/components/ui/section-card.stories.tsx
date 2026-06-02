import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import { SectionCard } from "./section-card";

const meta = {
  title: "Primitives/SectionCard",
  component: SectionCard,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text" },
    description: { control: "text" },
    collapsible: { control: "boolean" },
    defaultCollapsed: { control: "boolean" },
  },
  args: {
    title: "Section title",
    children: "Card body content goes here.",
    collapsible: false,
    defaultCollapsed: false,
  },
} satisfies Meta<typeof SectionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithDescription: Story = {
  args: { description: "A short summary of what this section contains." },
};

export const Collapsible: Story = {
  args: { collapsible: true },
};

export const DefaultCollapsed: Story = {
  args: { collapsible: true, defaultCollapsed: true },
};

export const WithActions: Story = {
  args: {
    description: "Header actions render to the right of the title.",
    actions: (
      <Button variant="outline" size="sm">
        Edit
      </Button>
    ),
  },
};
