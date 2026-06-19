import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "./input";
import { Label } from "./label";

const meta = {
  title: "Primitives/Label",
  component: Label,
  tags: ["autodocs"],
  argTypes: {
    children: { control: "text" },
    htmlFor: { control: "text" },
  },
  args: { children: "Email address" },
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithInput: Story = {
  render: (args) => (
    <div className="flex flex-col gap-1.5">
      <Label {...args} htmlFor="email" />
      <Input id="email" type="email" placeholder="you@example.com" />
    </div>
  ),
};

export const DisabledPeer: Story = {
  render: (args) => (
    <div className="flex flex-col gap-1.5">
      <Input id="disabled-email" className="peer" type="email" disabled />
      <Label {...args} htmlFor="disabled-email">
        Disabled field label
      </Label>
    </div>
  ),
};
