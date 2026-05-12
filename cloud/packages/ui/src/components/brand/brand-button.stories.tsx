"use client";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowRight, Plus, Settings } from "lucide-react";
import { BrandButton } from "./brand-button";

const meta: Meta<typeof BrandButton> = {
  title: "Brand/BrandButton",
  component: BrandButton,
  tags: ["autodocs"],
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "ghost", "outline", "icon", "icon-primary"],
    },
    size: {
      control: "select",
      options: ["sm", "md", "lg", "icon"],
    },
  },
  decorators: [
    (Story) => (
      <div style={{ backgroundColor: "#0a0a0a", padding: "2rem" }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof BrandButton>;

export const Primary: Story = {
  args: {
    children: "Get Started",
    variant: "primary",
  },
};

export const Ghost: Story = {
  args: {
    children: "Learn More",
    variant: "ghost",
  },
};

export const Outline: Story = {
  args: {
    children: "View Details",
    variant: "outline",
  },
};

export const WithIcon: Story = {
  args: {
    children: (
      <>
        <Plus className="h-4 w-4" /> Create New
      </>
    ),
    variant: "primary",
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap" }}>
      <BrandButton variant="primary">Primary</BrandButton>
      <BrandButton variant="ghost">Ghost</BrandButton>
      <BrandButton variant="outline">Outline</BrandButton>
      <BrandButton variant="icon" size="icon">
        <Settings className="h-4 w-4" />
      </BrandButton>
      <BrandButton variant="icon-primary" size="icon">
        <ArrowRight className="h-4 w-4" />
      </BrandButton>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
      <BrandButton size="sm">Small</BrandButton>
      <BrandButton size="md">Medium</BrandButton>
      <BrandButton size="lg">Large</BrandButton>
    </div>
  ),
};
