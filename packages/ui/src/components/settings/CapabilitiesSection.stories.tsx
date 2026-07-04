/**
 * Storybook stories for the Settings → Capabilities section, toggling the
 * wallet / browser / computer-use capabilities under a mock App context.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { mockApp, withMockApp } from "../../storybook/mock-providers.helpers";
import { CapabilitiesSection } from "./CapabilitiesSection";

const meta = {
  title: "Settings/CapabilitiesSection",
  component: CapabilitiesSection,
  tags: ["autodocs"],
  decorators: [withMockApp],
  parameters: { layout: "padded" },
} satisfies Meta<typeof CapabilitiesSection>;

export default meta;
type Story = StoryObj<typeof meta>;

// No backend in Storybook: the auto-training fetch on mount rejects, so the
// Auto-training row settles into its "unavailable" state. The capability
// toggles and the Capability Router connection form render fully.
export const Default: Story = {};

export const AllCapabilitiesEnabled: Story = {
  decorators: [
    mockApp({
      walletEnabled: true,
      browserEnabled: true,
      computerUseEnabled: true,
    }),
  ],
};

export const AllCapabilitiesDisabled: Story = {
  decorators: [
    mockApp({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: false,
    }),
  ],
};

export const ComputerUseEnabled: Story = {
  decorators: [
    mockApp({
      walletEnabled: false,
      browserEnabled: false,
      computerUseEnabled: true,
    }),
  ],
};
