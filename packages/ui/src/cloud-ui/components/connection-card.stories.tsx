import type { Meta, StoryObj } from "@storybook/react";
import { MessageCircle, Send } from "lucide-react";
import {
  ConnectionCallout,
  ConnectionCard,
  ConnectionConnectedBadge,
  ConnectionCopyRow,
  ConnectionDisconnectAction,
  ConnectionFooterActions,
  ConnectionIdentityPanel,
} from "./connection-card";

const meta = {
  title: "CloudUI/Components/ConnectionCard",
  component: ConnectionCard,
  tags: ["autodocs"],
  argTypes: {
    status: {
      control: "select",
      options: ["loading", "not-configured", "connected", "disconnected"],
    },
  },
  args: {
    name: "Discord Bot",
    icon: <MessageCircle />,
    description: "Connect a Discord bot so your agent can chat in your server.",
    status: "disconnected",
  },
} satisfies Meta<typeof ConnectionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const noop = () => {};

export const Disconnected: Story = {
  args: {
    setupContent: (
      <div className="space-y-3">
        <ConnectionCallout
          tone="muted"
          title="Before you start"
          items={[
            "Create a bot in the Discord Developer Portal",
            "Copy the bot token from the Bot tab",
            "Invite the bot to your server",
          ]}
        />
        <ConnectionCopyRow
          label="Invite URL"
          value="https://discord.com/api/oauth2/authorize?client_id=123"
          onCopied={noop}
        />
      </div>
    ),
  },
};

export const Connected: Story = {
  args: {
    status: "connected",
    statusBadge: <ConnectionConnectedBadge />,
    connectedContent: (
      <div className="space-y-4">
        <ConnectionIdentityPanel
          icon={<MessageCircle className="h-6 w-6 text-white" />}
          iconClassName="bg-[#5865F2]"
          title="Eliza Bot"
          subtitle="elizabot#4242 — joined 3 servers"
        />
        <ConnectionFooterActions note="Last sync: 2 minutes ago">
          <ConnectionDisconnectAction
            title="Disconnect Discord?"
            description="Your agent will stop responding in Discord channels until it is reconnected."
            onDisconnect={noop}
          />
        </ConnectionFooterActions>
      </div>
    ),
  },
};

export const Loading: Story = {
  args: {
    status: "loading",
  },
};

export const NotConfigured: Story = {
  args: {
    status: "not-configured",
    notConfiguredMessage:
      "The Discord integration is not enabled for this workspace. Ask your administrator to enable it.",
  },
};

export const TelegramConnected: Story = {
  args: {
    name: "Telegram Bot",
    icon: <Send />,
    description: "Talk to your agent through a Telegram bot.",
    status: "connected",
    statusBadge: <ConnectionConnectedBadge label="Active" />,
    connectedContent: (
      <div className="space-y-4">
        <ConnectionIdentityPanel
          icon={<Send className="h-6 w-6 text-white" />}
          iconClassName="bg-sky-500"
          title="@eliza_assistant_bot"
          subtitle="Webhook healthy — 1,284 messages handled"
        />
        <ConnectionCallout tone="green" title="All checks passed">
          <p className="text-xs">Webhook responding within 120ms.</p>
        </ConnectionCallout>
      </div>
    ),
  },
};
