import type { Meta, StoryObj } from "@storybook/react";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

const meta = {
  title: "UI/Label",
  component: Label,
  tags: ["autodocs"],
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: "Email address",
  },
};

export const WithInput: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <Label htmlFor="email">Email</Label>
      <Input type="email" id="email" placeholder="you@example.com" />
    </div>
  ),
};

export const WithDisabledInput: Story = {
  render: () => (
    <div className="grid w-full max-w-sm items-center gap-1.5">
      <Label htmlFor="disabled-input">Disabled field</Label>
      <Input
        id="disabled-input"
        disabled
        value="Cannot edit"
        className="peer"
      />
    </div>
  ),
};
