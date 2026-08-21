/** Storybook stories for the cockpit per-session mode picker. */
import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { CockpitModePicker } from "./CockpitModePicker";
import type { CockpitModeConfig } from "./cockpit-modes";

function Harness({
  initial,
  experimentalEnabled,
  disabled,
}: {
  initial: CockpitModeConfig;
  experimentalEnabled?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState<CockpitModeConfig>(initial);
  return (
    <div className="w-[340px]">
      <CockpitModePicker
        value={value}
        onChange={setValue}
        experimentalEnabled={experimentalEnabled}
        disabled={disabled}
      />
    </div>
  );
}

const meta = {
  title: "Cockpit/CockpitModePicker",
  component: CockpitModePicker,
  tags: ["autodocs"],
} satisfies Meta<typeof CockpitModePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ElizaCloud: Story = {
  render: () => (
    <Harness
      initial={{ mode: "eliza-cloud", agentType: "elizaos", tier: "small" }}
    />
  ),
};

export const ClaudeSubscription: Story = {
  render: () => (
    <Harness initial={{ mode: "subscription", agentType: "claude" }} />
  ),
};

export const ExperimentalArmed: Story = {
  render: () => (
    <Harness
      initial={{ mode: "eliza-cloud", agentType: "elizaos", tier: "large" }}
      experimentalEnabled
    />
  ),
};

export const Disabled: Story = {
  render: () => (
    <Harness initial={{ mode: "opencode", agentType: "opencode" }} disabled />
  ),
};
