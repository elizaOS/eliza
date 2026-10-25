/** Eager, lazy, and user-expanded states for advanced settings disclosure. */
import type { Meta, StoryObj } from "@storybook/react";
import { AdvancedSettingsDisclosure } from "./settings-control-primitives";

const meta = {
  title: "Settings/AdvancedSettingsDisclosure",
  component: AdvancedSettingsDisclosure,
  parameters: { layout: "padded" },
  args: {
    children: <div data-testid="advanced-body">Provider timeout: 30s</div>,
  },
} satisfies Meta<typeof AdvancedSettingsDisclosure>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};
export const Open: Story = { args: { defaultOpen: true } };
export const LazyOpen: Story = { args: { lazy: true, defaultOpen: true } };
