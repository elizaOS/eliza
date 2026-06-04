import type { Meta, StoryObj } from "@storybook/react";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { TranslationProvider } from "../../state/TranslationContext";
import { PolicyToggle } from "./PolicyToggle";

const meta = {
  title: "PolicyControls/PolicyToggle",
  component: PolicyToggle,
  tags: ["autodocs"],
  parameters: { layout: "padded" },
  args: {
    icon: ShieldCheck,
    title: "Spending Limit",
    summary: "$50/tx · $500/day · $2000/wk",
    enabled: true,
  },
  decorators: [
    (Story) => (
      <TranslationProvider>
        <div className="w-96">
          <Story />
        </div>
      </TranslationProvider>
    ),
  ],
} satisfies Meta<typeof PolicyToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Enabled: Story = {
  render: (args) => {
    const [enabled, setEnabled] = useState(args.enabled);
    return (
      <PolicyToggle {...args} enabled={enabled} onToggle={setEnabled}>
        <div className="text-xs text-muted">
          Expanded policy detail goes here.
        </div>
      </PolicyToggle>
    );
  },
};

export const Disabled: Story = {
  render: (args) => {
    const [enabled, setEnabled] = useState(false);
    return (
      <PolicyToggle {...args} enabled={enabled} onToggle={setEnabled}>
        <div className="text-xs text-muted">
          Expanded policy detail goes here.
        </div>
      </PolicyToggle>
    );
  },
};

export const WithoutSummary: Story = {
  args: { summary: undefined, title: "Approved Addresses" },
  render: (args) => {
    const [enabled, setEnabled] = useState(args.enabled);
    return (
      <PolicyToggle {...args} enabled={enabled} onToggle={setEnabled}>
        <div className="text-xs text-muted">Address list editor goes here.</div>
      </PolicyToggle>
    );
  },
};
