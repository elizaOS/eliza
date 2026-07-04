/** Storybook stories for the cockpit session-start form. */
import type { Meta, StoryObj } from "@storybook/react";

import { CockpitNewSessionForm } from "./CockpitNewSessionForm";

const meta = {
  title: "Cockpit/CockpitNewSessionForm",
  component: CockpitNewSessionForm,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="w-[360px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CockpitNewSessionForm>;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const Default: Story = {
  args: { onCreate: noop },
};

export const ExperimentalArmed: Story = {
  args: { onCreate: noop, experimentalEnabled: true },
};

export const Busy: Story = {
  args: { onCreate: noop, busy: true },
};
