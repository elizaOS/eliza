/**
 * Storybook stories for `ConnectorChannelModeSwitch` — the global Delegate/Bot
 * lens toggle at the top of Settings → Connectors — under a mock app context.
 * The switch writes the shared channel-mode store, so toggling in the story is
 * live.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ConnectorChannelModeSwitch } from "./ConnectorChannelModeSwitch";

const meta = {
  title: "Connectors/ConnectorChannelModeSwitch",
  component: ConnectorChannelModeSwitch,
  decorators: [
    (Story) => (
      <MockAppProvider>
        <Story />
      </MockAppProvider>
    ),
  ],
} satisfies Meta<typeof ConnectorChannelModeSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
