import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TranslationProvider } from "../../state/TranslationProvider";
import { DEFAULT_SPENDING } from "./constants";
import { SpendingLimitSection } from "./SpendingLimitSection";
import type { SpendingLimitConfig } from "./types";

const meta = {
  title: "PolicyControls/SpendingLimitSection",
  component: SpendingLimitSection,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-[480px]">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof SpendingLimitSection>;

export default meta;
type Story = StoryObj<typeof meta>;

function Interactive({ initial }: { initial: SpendingLimitConfig }) {
  const [config, setConfig] = useState(initial);
  return <SpendingLimitSection config={config} onChange={setConfig} />;
}

export const Default: Story = {
  render: () => <Interactive initial={DEFAULT_SPENDING} />,
};

export const Empty: Story = {
  render: () => (
    <Interactive initial={{ maxPerTx: "", maxPerDay: "", maxPerWeek: "" }} />
  ),
};

export const HighLimits: Story = {
  render: () => (
    <Interactive
      initial={{ maxPerTx: "1000", maxPerDay: "10000", maxPerWeek: "50000" }}
    />
  ),
};
