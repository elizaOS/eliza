import type { UiLanguage } from "@elizaos/app-core/i18n";
import type { UiTheme } from "@elizaos/app-core/state";
import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { CompanionHeader } from "../components/companion/CompanionHeader";

const meta = {
  title: "Companion/CompanionHeader",
  component: CompanionHeader,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    name: "Eliza",
    agentState: "idle",
    stateColor: "text-ok border-ok",
    lifecycleBusy: false,
    restartBusy: false,

    handleRestart: fn(),
    elizaCloudEnabled: true,
    elizaCloudConnected: false,
    elizaCloudCredits: 100,
    creditColor: "text-ok border-ok",
    elizaCloudTopUpUrl: "https://elizacloud.ai/dashboard/settings?tab=billing",
    evmShort: "0x12...34ab",
    solShort: null,
    handleSwitchToNativeShell: fn(),
    uiLanguage: "en-US" as UiLanguage,
    setUiLanguage: fn(),
    uiTheme: "dark" as UiTheme,
    setUiTheme: fn(),
    t: (key: string) => key,
  },
} satisfies Meta<typeof CompanionHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultRunning: Story = {};

export const Thinking: Story = {
  args: {
    agentState: "thinking",
    stateColor: "bg-blue-500",
    elizaCloudEnabled: true,
    elizaCloudConnected: true,
    elizaCloudCredits: 100,
    elizaCloudTopUpUrl: "https://elizacloud.ai/dashboard/settings?tab=billing",
  },
};

export const DisconnectedWithoutCredits: Story = {
  args: {
    elizaCloudConnected: false,
    elizaCloudCredits: null,
  },
};

export const MobileView: Story = {
  parameters: {
    viewport: {
      defaultViewport: "iphonex",
    },
  },
};

export const TabletView: Story = {
  parameters: {
    viewport: {
      defaultViewport: "ipad",
    },
  },
};
