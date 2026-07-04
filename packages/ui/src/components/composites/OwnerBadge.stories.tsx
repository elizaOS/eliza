/**
 * Storybook states for the OwnerBadge shared UI component across
 * representative layouts and variants.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { OwnerBadge } from "./OwnerBadge";

const meta = {
  title: "Composites/OwnerBadge",
  component: OwnerBadge,
  tags: ["autodocs"],
  argTypes: {
    isOwner: { control: "boolean" },
    variant: { control: "select", options: ["inline", "overlay", "card"] },
    size: { control: "select", options: ["xs", "sm", "md"] },
    tooltip: { control: "text" },
  },
  args: {
    isOwner: true,
    variant: "inline",
    size: "sm",
    tooltip: "OWNER — full control",
  },
} satisfies Meta<typeof OwnerBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Inline: Story = {
  render: (args) => (
    <span className="inline-flex items-center gap-1 text-sm">
      Ada Lovelace
      <OwnerBadge {...args} />
    </span>
  ),
  args: { variant: "inline" },
};

export const Overlay: Story = {
  render: (args) => (
    <div className="relative h-10 w-10 rounded-full bg-accent/20">
      <OwnerBadge {...args} />
    </div>
  ),
  args: { variant: "overlay", size: "xs" },
};

export const Card: Story = {
  args: { variant: "card", size: "md" },
};

/** Renders nothing when the viewer is not the owner. */
export const NotOwner: Story = {
  args: { isOwner: false },
};
