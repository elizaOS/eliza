import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TranslationProvider } from "../../state/TranslationProvider";
import { AutoApproveSection } from "./AutoApproveSection";
import { DEFAULT_AUTO_APPROVE } from "./constants";
import type { AutoApproveConfig } from "./types";

const meta = {
  title: "PolicyControls/AutoApproveSection",
  component: AutoApproveSection,
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
} satisfies Meta<typeof AutoApproveSection>;

export default meta;
type Story = StoryObj<typeof meta>;

function Interactive({ initial }: { initial: AutoApproveConfig }) {
  const [config, setConfig] = useState(initial);
  return <AutoApproveSection config={config} onChange={setConfig} />;
}

export const Default: Story = {
  render: () => <Interactive initial={DEFAULT_AUTO_APPROVE} />,
};

export const HigherThreshold: Story = {
  render: () => <Interactive initial={{ threshold: "100" }} />,
};

export const ZeroThreshold: Story = {
  render: () => <Interactive initial={{ threshold: "0" }} />,
};
