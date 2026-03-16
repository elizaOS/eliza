import type { Meta, StoryObj } from "@storybook/react";
import React from "react";
import { Button } from "../components/ui/button";

const meta: Meta<typeof Button> = {
  title: "Atoms/Button",
  component: Button,
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "destructive",
        "outline",
        "secondary",
        "ghost",
        "link",
      ],
    },
    size: { control: "select", options: ["default", "sm", "lg", "icon"] },
  },
};
export default meta;
type Story = StoryObj<typeof Button>;

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3 items-center">
      <Button>Primary</Button>
      <Button variant="destructive">Destroy</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Button variant="link">Link</Button>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <Button size="sm">sm</Button>
      <Button>default</Button>
      <Button size="lg">lg</Button>
    </div>
  ),
};

export const Disabled: Story = { args: { children: "Locked", disabled: true } };
