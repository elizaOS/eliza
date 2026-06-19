import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";

const meta = {
  title: "Primitives/HoverCard",
  component: HoverCard,
  tags: ["autodocs"],
  args: { open: true },
} satisfies Meta<typeof HoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <HoverCard {...args}>
      <HoverCardTrigger asChild>
        <Button variant="link">@elizaos</Button>
      </HoverCardTrigger>
      <HoverCardContent>
        <p className="text-sm font-medium">elizaOS</p>
        <p className="mt-1 text-sm text-muted">
          Open-source framework for building autonomous AI agents.
        </p>
      </HoverCardContent>
    </HoverCard>
  ),
};

export const AlignStart: Story = {
  render: (args) => (
    <HoverCard {...args}>
      <HoverCardTrigger asChild>
        <Button variant="outline">Hover for details</Button>
      </HoverCardTrigger>
      <HoverCardContent align="start">
        <p className="text-sm">
          Content anchored to the start edge of the trigger.
        </p>
      </HoverCardContent>
    </HoverCard>
  ),
};

export const TopSide: Story = {
  render: (args) => (
    <HoverCard {...args}>
      <HoverCardTrigger asChild>
        <Button variant="ghost">Open upward</Button>
      </HoverCardTrigger>
      <HoverCardContent side="top" sideOffset={8}>
        <p className="text-sm">This card opens above the trigger.</p>
      </HoverCardContent>
    </HoverCard>
  ),
};
