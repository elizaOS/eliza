import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { FieldSwitch } from "../index";

const meta = {
  title: "Composites/FieldSwitch",
  component: FieldSwitch,
  tags: ["autodocs"],
  parameters: { layout: "centered" },
} satisfies Meta<typeof FieldSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

function FieldSwitchDemo({
  initialChecked = false,
}: {
  initialChecked?: boolean;
}) {
  const [checked, setChecked] = useState(initialChecked);
  return (
    <div className="w-80">
      <FieldSwitch
        checked={checked}
        onCheckedChange={setChecked}
        label="Enable notifications"
      />
    </div>
  );
}

export const Off: Story = {
  render: () => <FieldSwitchDemo />,
};

export const On: Story = {
  render: () => <FieldSwitchDemo initialChecked />,
};

export const Disabled: Story = {
  render: () => (
    <div className="w-80 space-y-2">
      <FieldSwitch checked={false} label="Disabled off" disabled />
      <FieldSwitch checked label="Disabled on" disabled />
    </div>
  ),
};
