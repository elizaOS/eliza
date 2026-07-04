/** Storybook stories for SetupStepDivider — default, between-steps, on-light-background, and stacked states. */

import type { Meta, StoryObj } from "@storybook/react";
import { SetupStepDivider } from "./setup-step-chrome";

const meta = {
  title: "Setup/SetupStepDivider",
  component: SetupStepDivider,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div
        style={{
          width: 360,
          padding: 24,
          background: "#111",
          // Provide the CSS var the divider references.
          ["--first-run-divider" as string]: "rgba(240,185,11,0.6)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SetupStepDivider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const BetweenSteps: Story = {
  render: () => (
    <div className="text-white">
      <div>Step 1 — Pick a name</div>
      <SetupStepDivider />
      <div>Step 2 — Choose a voice</div>
      <SetupStepDivider />
      <div>Step 3 — Confirm</div>
    </div>
  ),
};

export const OnLightBackground: Story = {
  decorators: [
    (Story) => (
      <div
        style={{
          width: 360,
          padding: 24,
          background: "#f5f5f5",
          color: "#111",
          ["--first-run-divider" as string]: "rgba(120,90,0,0.6)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export const Stacked: Story = {
  render: () => (
    <div className="flex flex-col gap-2 text-white">
      <SetupStepDivider />
      <SetupStepDivider />
      <SetupStepDivider />
    </div>
  ),
};
