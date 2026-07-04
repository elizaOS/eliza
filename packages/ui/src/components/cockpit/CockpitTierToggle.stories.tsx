/** Storybook stories for the running-session Fast/Smart tier toggle. */
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { CockpitTierToggle } from "./CockpitTierToggle";
import type { ElizaCloudTier } from "./cockpit-modes";

function Harness({
  initial,
  disabled,
}: {
  initial: ElizaCloudTier;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<ElizaCloudTier>(initial);
  return (
    <div className="w-[260px]">
      <CockpitTierToggle
        value={value}
        onChange={setValue}
        disabled={disabled}
      />
    </div>
  );
}

const meta = {
  title: "Cockpit/CockpitTierToggle",
  component: CockpitTierToggle,
  tags: ["autodocs"],
} satisfies Meta<typeof CockpitTierToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Fast: Story = {
  render: () => <Harness initial="small" />,
};

export const Smart: Story = {
  render: () => <Harness initial="large" />,
};

export const Disabled: Story = {
  render: () => <Harness initial="small" disabled />,
};
