import type { Meta, StoryObj } from "@storybook/react";
import { Switch } from "./switch";

const meta = {
  title: "Primitives/Switch",
  component: Switch,
  tags: ["autodocs"],
  argTypes: {
    checked: { control: "boolean" },
    defaultChecked: { control: "boolean" },
    disabled: { control: "boolean" },
  },
  args: { defaultChecked: false, disabled: false },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const On: Story = { args: { defaultChecked: true } };
export const Disabled: Story = { args: { disabled: true } };
export const DisabledOn: Story = { args: { disabled: true, checked: true } };

/** Paired with a label, as it appears in settings rows. */
export const WithLabel: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      <Switch id="sw-notif" {...args} />
      <label htmlFor="sw-notif" className="text-sm">
        Enable notifications
      </label>
    </div>
  ),
};
