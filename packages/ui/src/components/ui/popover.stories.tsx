import type { Meta, StoryObj } from "@storybook/react";
import { Button } from "./button";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

const meta = {
  title: "Primitives/Popover",
  component: Popover,
  tags: ["autodocs"],
  args: { open: true },
} satisfies Meta<typeof Popover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <Popover {...args}>
      <PopoverTrigger asChild>
        <Button variant="outline">Open popover</Button>
      </PopoverTrigger>
      <PopoverContent>
        <p className="text-sm font-medium">Dimensions</p>
        <p className="mt-1 text-sm text-muted">
          Set the width and height for the layer.
        </p>
      </PopoverContent>
    </Popover>
  ),
};

export const WithForm: Story = {
  render: (args) => (
    <Popover {...args}>
      <PopoverTrigger asChild>
        <Button variant="outline">Edit profile</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="popover-name">
              Name
            </label>
            <input
              className="rounded-sm border border-border bg-bg px-2 py-1 text-sm"
              defaultValue="Eliza"
              id="popover-name"
            />
          </div>
          <Button size="sm">Save</Button>
        </div>
      </PopoverContent>
    </Popover>
  ),
};

export const AlignStart: Story = {
  render: (args) => (
    <Popover {...args}>
      <PopoverTrigger asChild>
        <Button variant="outline">Aligned to start</Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <p className="text-sm">This panel is left-aligned to the trigger.</p>
      </PopoverContent>
    </Popover>
  ),
};
