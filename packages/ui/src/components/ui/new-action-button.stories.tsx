/**
 * Storybook stories for the new-action button primitive.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { NewActionButton } from "./new-action-button";

const meta = {
  title: "Primitives/NewActionButton",
  component: NewActionButton,
  tags: ["autodocs"],
  argTypes: {
    size: { control: "select", options: ["default", "sm", "lg", "icon"] },
    disabled: { control: "boolean" },
    children: { control: "text" },
  },
  args: { children: "New conversation", size: "default" },
} satisfies Meta<typeof NewActionButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const StripsLeadingPlus: Story = {
  args: { children: "+ New project" },
};

export const Small: Story = { args: { size: "sm", children: "New file" } };

export const Disabled: Story = { args: { disabled: true } };
