import type { Meta, StoryObj } from "@storybook/react";
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

const DiscordIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-[#5865F2]">
    <path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z" />
  </svg>
);

export const Loading: Story = {
  args: {
    name: "Discord Bot",
    icon: <DiscordIcon />,
    description: "Connect your Discord bot",
    status: "loading",
  },
};

export const Connected: Story = {
  args: {
    name: "Discord Bot",
    icon: <DiscordIcon />,
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
    icon: <DiscordIcon />,
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
