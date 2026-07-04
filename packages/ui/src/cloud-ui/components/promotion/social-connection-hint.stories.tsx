/**
 * Storybook stories for the SocialConnectionHint.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { MemoryRouter } from "react-router-dom";
import { SocialConnectionHint } from "./social-connection-hint";

const disconnected = {
  discord: { configured: false, connected: false },
  telegram: { configured: false, connected: false },
};

const automationOff = {
  discord: { enabled: false, ready: false },
  telegram: { enabled: false, ready: false },
};

const meta = {
  title: "CloudUI/Promotion/SocialConnectionHint",
  component: SocialConnectionHint,
  tags: ["autodocs"],
  parameters: {
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#0a0a0a" }],
    },
  },
  decorators: [
    (Story) => (
      <MemoryRouter initialEntries={["/dashboard"]}>
        <div
          className="max-w-2xl space-y-4 p-6"
          style={{ background: "#0a0a0a" }}
        >
          <Story />
        </div>
      </MemoryRouter>
    ),
  ],
  args: {
    connectionStatus: disconnected,
    automationStatus: automationOff,
  },
} satisfies Meta<typeof SocialConnectionHint>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Neither platform connected and no automation enabled: both the Discord and
 * Telegram hint cards render, plus the "connect at least one" footer note.
 *
 * Note: hints are also gated by a dismissed flag persisted in `localStorage`.
 * In Storybook that key is unset on first mount, so the cards show.
 */
export const Default: Story = {};

/**
 * Telegram already connected at the org level, so only the Discord hint shows.
 */
export const DiscordOnly: Story = {
  args: {
    connectionStatus: {
      discord: { configured: false, connected: false },
      telegram: { configured: true, connected: true, botUsername: "eliza_bot" },
    },
  },
};

/**
 * Discord already connected, so only the Telegram hint shows.
 */
export const TelegramOnly: Story = {
  args: {
    connectionStatus: {
      discord: { configured: true, connected: true, guildCount: 3 },
      telegram: { configured: false, connected: false },
    },
  },
};

/**
 * Discord automation is already enabled for this app, so its hint is
 * suppressed even though the org-level connection is absent — only the
 * Telegram hint remains.
 */
export const DiscordAutomationEnabled: Story = {
  args: {
    automationStatus: {
      discord: { enabled: true, ready: true },
      telegram: { enabled: false, ready: false },
    },
  },
};

/**
 * Both platforms connected: the component returns `null` and renders nothing.
 * Storybook shows an empty surface confirming the early-return path.
 */
export const AllConnected: Story = {
  args: {
    connectionStatus: {
      discord: { configured: true, connected: true, guildCount: 2 },
      telegram: { configured: true, connected: true, botUsername: "eliza_bot" },
    },
  },
};
