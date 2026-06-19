import type { Meta, StoryObj } from "@storybook/react";
import * as React from "react";
import { FieldSwitch } from "./field-switch";

const meta = {
  title: "Primitives/FieldSwitch",
  component: FieldSwitch,
  tags: ["autodocs"],
  argTypes: {
    checked: { control: "boolean" },
    label: { control: "text" },
    disabled: { control: "boolean" },
  },
  args: { checked: false, label: "Enable notifications" },
} satisfies Meta<typeof FieldSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
  args: { checked: true, label: "Notifications enabled" },
};

export const Disabled: Story = {
  args: { disabled: true, label: "Locked setting" },
};

/** Controlled usage — clicking toggles the bound state. */
export const Interactive: Story = {
  render: (args) => {
    const [checked, setChecked] = React.useState(args.checked);
    return (
      <FieldSwitch
        {...args}
        checked={checked}
        onCheckedChange={setChecked}
        label={checked ? "Auto-respond on" : "Auto-respond off"}
      />
    );
  },
};
