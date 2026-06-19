import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TranslationProvider } from "../../state/TranslationProvider";
import { DEFAULT_RATE_LIMIT } from "./constants";
import { RateLimitSection } from "./RateLimitSection";
import type { RateLimitConfig } from "./types";

const meta = {
  title: "PolicyControls/RateLimitSection",
  component: RateLimitSection,
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
} satisfies Meta<typeof RateLimitSection>;

export default meta;
type Story = StoryObj<typeof meta>;

function Interactive({ initial }: { initial: RateLimitConfig }) {
  const [config, setConfig] = useState(initial);
  return <RateLimitSection config={config} onChange={setConfig} />;
}

export const Default: Story = {
  render: () => <Interactive initial={DEFAULT_RATE_LIMIT} />,
};

export const HighThroughput: Story = {
  render: () => (
    <Interactive initial={{ maxTxPerHour: 80, maxTxPerDay: 800 }} />
  ),
};

export const Conservative: Story = {
  render: () => <Interactive initial={{ maxTxPerHour: 1, maxTxPerDay: 5 }} />,
};
