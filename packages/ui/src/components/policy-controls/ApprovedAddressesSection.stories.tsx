import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TranslationProvider } from "../../state/TranslationContext";
import { ApprovedAddressesSection } from "./ApprovedAddressesSection";
import type { ApprovedAddressesConfig } from "./types";

const meta = {
  title: "PolicyControls/ApprovedAddressesSection",
  component: ApprovedAddressesSection,
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
} satisfies Meta<typeof ApprovedAddressesSection>;

export default meta;
type Story = StoryObj<typeof meta>;

function Interactive({ initial }: { initial: ApprovedAddressesConfig }) {
  const [config, setConfig] = useState(initial);
  return <ApprovedAddressesSection config={config} onChange={setConfig} />;
}

export const EmptyAllowlist: Story = {
  render: () => (
    <Interactive initial={{ addresses: [], labels: {}, mode: "whitelist" }} />
  ),
};

export const Populated: Story = {
  render: () => (
    <Interactive
      initial={{
        addresses: [
          "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
          "DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy",
        ],
        labels: {
          "0x742d35Cc6634C0532925a3b844Bc454e4438f44e": "Treasury",
        },
        mode: "whitelist",
      }}
    />
  ),
};

export const Blocklist: Story = {
  render: () => (
    <Interactive
      initial={{
        addresses: ["0x000000000000000000000000000000000000dEaD"],
        labels: { "0x000000000000000000000000000000000000dEaD": "Burn" },
        mode: "blacklist",
      }}
    />
  ),
};
