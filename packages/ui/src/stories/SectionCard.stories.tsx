import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "../components/ui/button";
import { SectionCard } from "../components/ui/section-card";

const meta = {
  title: "UI/SectionCard",
  component: SectionCard,
  tags: ["autodocs"],
  argTypes: {
    title: { control: "text" },
    description: { control: "text" },
    collapsible: { control: "boolean" },
    defaultCollapsed: { control: "boolean" },
  },
  args: {
    title: "Section Title",
  },
} satisfies Meta<typeof SectionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: "Section Title",
    children: "This is the section content.",
  },
};

export const WithDescription: Story = {
  args: {
    title: "Configuration",
    description: "Manage your application settings below.",
    children: "Settings content goes here.",
  },
};

export const WithActions: Story = {
  args: {
    title: "Plugins",
    description: "Installed plugins for this agent.",
    children: "Plugin list content goes here.",
  },
  render: (args) => (
    <SectionCard
      {...args}
      actions={
        <Button variant="outline" size="sm">
          Add Plugin
        </Button>
      }
    />
  ),
};

export const CollapsibleExpanded: Story = {
  args: {
    title: "Advanced Settings",
    description: "Click the title to collapse.",
    collapsible: true,
    defaultCollapsed: false,
    children: "This content is visible by default and can be collapsed.",
  },
};

export const CollapsibleCollapsed: Story = {
  args: {
    title: "Advanced Settings",
    description: "Click the title to expand.",
    collapsible: true,
    defaultCollapsed: true,
    children: "This content is hidden by default.",
  },
};

export const NoTitle: Story = {
  args: {
    title: undefined,
    children: "A section card with no header, just content.",
  },
};
