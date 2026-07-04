/**
 * Storybook stories for the checkbox primitive (checked/unchecked, disabled, required).
 */
import type { Meta, StoryObj } from "@storybook/react";
import { Checkbox } from "./checkbox";

const meta = {
  title: "Primitives/Checkbox",
  component: Checkbox,
  tags: ["autodocs"],
  argTypes: {
    checked: { control: "boolean" },
    disabled: { control: "boolean" },
    required: { control: "boolean" },
  },
  args: { disabled: false, required: false },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Checked: Story = { args: { checked: true } };
export const Disabled: Story = { args: { disabled: true } };
export const DisabledChecked: Story = {
  args: { disabled: true, checked: true },
};

/** Paired with a label, the common usage. */
export const WithLabel: Story = {
  render: (args) => (
    <div className="flex items-center gap-2 text-sm">
      <Checkbox id="cb-terms" {...args} />
      <label htmlFor="cb-terms">Accept terms and conditions</label>
    </div>
  ),
  args: { defaultChecked: true },
};
