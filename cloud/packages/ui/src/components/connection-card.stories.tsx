import type { Meta, StoryObj } from "@storybook/react";
import { DiscordIcon } from "./icons";
import { ConnectionCard } from "./connection-card";

const meta: Meta<typeof ConnectionCard> = {
  title: "Components/ConnectionCard",
  component: ConnectionCard,
  parameters: { backgrounds: { default: "dark" } },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 600, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof ConnectionCard>;

export const Loading: Story = {
  args: {
    name: "Discord Bot",
    icon: <DiscordIcon className="h-5 w-5 text-[#5865F2]" />,
    description: "Connect your Discord bot",
    status: "loading",
  },
};

export const Connected: Story = {
  args: {
    name: "Discord Bot",
    icon: <DiscordIcon className="h-5 w-5 text-[#5865F2]" />,
    description: "Your Discord bot is active and connected",
    status: "connected",
    statusBadge: (
      <span
        style={{
          padding: "2px 8px",
          background: "#22c55e20",
          color: "#22c55e",
          border: "1px solid #22c55e40",
          fontSize: 11,
        }}
      >
        Online
      </span>
    ),
    connectedContent: (
      <div style={{ color: "#aaa", fontSize: 14 }}>Bot is connected to 3 servers</div>
    ),
  },
};

export const Disconnected: Story = {
  args: {
    name: "Discord Bot",
    icon: <DiscordIcon className="h-5 w-5 text-[#5865F2]" />,
    description: "Connect your Discord bot to start receiving messages",
    status: "disconnected",
    setupContent: (
      <div style={{ padding: 16, background: "#111", borderRadius: 8 }}>
        <p style={{ color: "#888", fontSize: 14, margin: 0 }}>
          Enter your Discord bot token to connect
        </p>
      </div>
    ),
  },
};

export const NotConfigured: Story = {
  args: {
    name: "Telegram",
    icon: <span>📱</span>,
    description: "...",
    status: "not-configured",
  },
};
