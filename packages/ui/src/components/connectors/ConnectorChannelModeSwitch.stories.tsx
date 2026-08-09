/**
 * Storybook stories for `ConnectorChannelModeSwitch` — the global Delegate/Bot
 * lens toggle at the top of Settings → Connectors — under a mock app context.
 * The switch writes the shared channel-mode store, so toggling in the story is
 * live.
 */

import type { Meta, StoryObj } from "@storybook/react";
import type { AppContextValue } from "../../state/types";
import { AppContext } from "../../state/useApp";
import { ConnectorChannelModeSwitch } from "./ConnectorChannelModeSwitch";

const mockAppContext = new Proxy({} as AppContextValue, {
  get(_, prop) {
    if (prop === "t") {
      return (_key: string, opts?: { defaultValue?: string }) =>
        opts?.defaultValue ?? "";
    }
    if (prop === "uiLanguage") return "en";
    return () => {};
  },
});

const meta = {
  title: "Connectors/ConnectorChannelModeSwitch",
  component: ConnectorChannelModeSwitch,
  decorators: [
    (Story) => (
      <AppContext.Provider value={mockAppContext}>
        <Story />
      </AppContext.Provider>
    ),
  ],
} satisfies Meta<typeof ConnectorChannelModeSwitch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
