/**
 * Storybook stories for `ConnectorModeSelector` — a connector with multiple
 * modes, and cloud-only modes gated on Eliza Cloud connectivity — under a mock
 * app context.
 */

import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { MockAppProvider } from "../../storybook/mock-providers";
import { ConnectorModeSelector } from "./ConnectorModeSelector";

function Wrapper(props: {
  connectorId: string;
  initialMode: string;
  elizaCloudConnected?: boolean;
}) {
  const [selectedMode, setSelectedMode] = useState(props.initialMode);
  return (
    <ConnectorModeSelector
      connectorId={props.connectorId}
      selectedMode={selectedMode}
      onModeChange={setSelectedMode}
      elizaCloudConnected={props.elizaCloudConnected}
    />
  );
}

const meta = {
  title: "Connectors/ConnectorModeSelector",
  component: Wrapper,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <MockAppProvider>
        <div className="max-w-xl p-6">
          <Story />
        </div>
      </MockAppProvider>
    ),
  ],
  argTypes: {
    connectorId: {
      control: "select",
      options: ["discord", "telegram", "slack", "x", "whatsapp", "imessage"],
    },
    initialMode: { control: "text" },
    elizaCloudConnected: { control: "boolean" },
  },
  args: {
    connectorId: "discord",
    initialMode: "bot",
    elizaCloudConnected: false,
  },
} satisfies Meta<typeof Wrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DiscordLocal: Story = {
  args: {
    connectorId: "discord",
    initialMode: "bot",
    elizaCloudConnected: false,
  },
};

export const DiscordWithCloud: Story = {
  args: {
    connectorId: "discord",
    initialMode: "managed",
    elizaCloudConnected: true,
  },
};

export const TelegramWithCloud: Story = {
  args: {
    connectorId: "telegram",
    initialMode: "cloud-bot",
    elizaCloudConnected: true,
  },
};

export const WhatsApp: Story = {
  args: {
    connectorId: "whatsapp",
    initialMode: "qr",
    elizaCloudConnected: false,
  },
};

export const IMessageWithCloud: Story = {
  args: {
    connectorId: "imessage",
    initialMode: "direct",
    elizaCloudConnected: true,
  },
};
