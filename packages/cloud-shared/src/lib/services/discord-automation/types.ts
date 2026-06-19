/**
 * Discord Automation Types
 *
 * Type definitions for Discord bot automation service.
 */

export interface DiscordGuildInfo {
  id: string;
  name: string;
  icon: string | null;
  owner: boolean;
  permissions: string;
  features: string[];
}

export interface DiscordChannelInfo {
  id: string;
  name: string;
  type: number; // Discord ChannelType enum value
  parent_id: string | null;
  position: number;
  guild_id: string;
  nsfw?: boolean;
}

export interface DiscordConnectionStatus {
  connected: boolean;
  guilds: Array<{
    id: string;
    name: string;
    iconUrl: string | null;
    channelCount: number;
  }>;
  error?: string;
}

export interface DiscordAutomationConfig {
  enabled: boolean;
  guildId?: string;
  channelId?: string;
  autoAnnounce: boolean;
  announceIntervalMin: number;
  announceIntervalMax: number;
  vibeStyle?: string;
  lastAnnouncementAt?: string;
  totalMessages?: number;
  agentCharacterId?: string; // Character used for automation voice
}

export interface DiscordAutomationStatus {
  enabled: boolean;
  discordConnected: boolean;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  autoAnnounce: boolean;
  announceIntervalMin?: number;
  announceIntervalMax?: number;
  lastAnnouncementAt?: string;
  totalMessages: number;
  agentCharacterId?: string; // Character voice for posts
}

export interface OAuthState {
  organizationId: string;
  userId: string;
  returnUrl: string;
  nonce: string;
  flow?: "organization-install" | "agent-managed";
  agentId?: string;
  botNickname?: string;
}

export interface DiscordOAuthIdentity {
  accessToken: string;
  guilds: DiscordGuildInfo[];
  user: {
    id: string;
    username: string;
    globalName: string | null;
    avatar: string | null;
  };
}

export interface SendMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface PostResult {
  success: boolean;
  messageId?: string;
  channelId?: string;
  error?: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

export interface DiscordButtonComponent {
  type: 2; // Button
  style: 5; // Link style
  label: string;
  url: string;
}

export interface DiscordActionRow {
  type: 1; // Action Row
  components: DiscordButtonComponent[];
}
