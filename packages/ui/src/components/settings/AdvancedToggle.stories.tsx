import type { Meta, StoryObj } from "@storybook/react";
import { withMockApp } from "../../storybook/mock-providers.helpers";
import { AdvancedToggle } from "./AdvancedToggle";

const meta = {
  title: "Settings/AdvancedToggle",
  component: AdvancedToggle,
  tags: ["autodocs"],
  decorators: [
    withMockApp,
    (Story) => (
      <div className="p-6">
        <Story />
      </div>
    ),
  ],
  argTypes: {
    label: { control: "text" },
    className: { control: false },
    onChange: { action: "changed" },
  },
  args: {
    onChange: () => {},
  },
} satisfies Meta<typeof AdvancedToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const CustomLabel: Story = {
  args: {
    label: "Power-user mode",
  },
};

export const CustomStyling: Story = {
  args: {
    label: "Show advanced options",
    className:
      "inline-flex items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2 text-sm font-semibold text-primary",
  },
};

export const InSettingsRow: Story = {
  render: (args) => (
    <div className="flex max-w-md items-center justify-between rounded-md border border-border/50 bg-bg-elevated px-4 py-3">
      <div>
        <div className="text-sm font-medium text-fg">ASR provider</div>
        <div className="text-xs-tight text-muted">
          Reveal power-user knobs like the speech recognition backend.
        </div>
      </div>
      <AdvancedToggle {...args} />
    </div>
  ),
};
