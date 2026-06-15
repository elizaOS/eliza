import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import {
  Tooltip,
  TooltipContent,
  TooltipHint,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip";

const meta = {
  title: "Primitives/Tooltip",
  component: TooltipHint,
  tags: ["autodocs"],
  argTypes: {
    content: { control: "text" },
    side: {
      control: "select",
      options: ["top", "right", "bottom", "left"],
    },
    sideOffset: { control: "number" },
    delayDuration: { control: "number" },
  },
  args: {
    content: "Helpful hint",
    side: "bottom",
    children: <Button variant="outline">Hover me</Button>,
  },
} satisfies Meta<typeof TooltipHint>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Top: Story = { args: { side: "top", content: "Shown above" } };

export const Right: Story = {
  args: { side: "right", content: "Shown to the right" },
};

export const Left: Story = {
  args: { side: "left", content: "Shown to the left" },
};

/** The composed primitives wired up manually, forced open so the content is visible. */
export const Composed: Story = {
  render: () => (
    <TooltipProvider>
      <Tooltip defaultOpen>
        <TooltipTrigger asChild>
          <Button variant="outline">Always visible</Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Tooltip content</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
};
