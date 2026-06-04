import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TranslationProvider } from "../../state/TranslationContext";
import { DEFAULT_TIME_WINDOW } from "./constants";
import { TimeWindowSection } from "./TimeWindowSection";
import type { TimeWindowConfig } from "./types";

const meta = {
  title: "PolicyControls/TimeWindowSection",
  component: TimeWindowSection,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-96">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof TimeWindowSection>;

export default meta;
type Story = StoryObj<typeof meta>;

function Interactive({ initial }: { initial: TimeWindowConfig }) {
  const [config, setConfig] = useState(initial);
  return <TimeWindowSection config={config} onChange={setConfig} />;
}

export const BusinessHours: Story = {
  render: () => <Interactive initial={DEFAULT_TIME_WINDOW} />,
};

export const AllWeek: Story = {
  render: () => (
    <Interactive
      initial={{
        allowedHours: [{ start: 0, end: 23 }],
        allowedDays: [0, 1, 2, 3, 4, 5, 6],
        timezone: "UTC",
      }}
    />
  ),
};

export const WeekendsOnly: Story = {
  render: () => (
    <Interactive
      initial={{
        allowedHours: [{ start: 10, end: 22 }],
        allowedDays: [0, 6],
        timezone: "America/Los_Angeles",
      }}
    />
  ),
};
