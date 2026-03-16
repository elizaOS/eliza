/**
 * Discord Automation Service
 *
 * Handles OAuth flow, guild management, and message sending.
 * Uses Discord REST API for all operations (serverless-compatible).
 */

import { discordGuildsRepository } from "@/db/repositories/discord-guilds";
import { discordChannelsRepository } from "@/db/repositories/discord-channels";
import { logger } from "@/lib/utils/logger";
import {
  getGuildIconUrl,
  isTextChannel,
  DISCORD_BLURPLE,
  DISCORD_RATE_LIMITS,
  splitMessage,
  createActionRow,
  createEmbed,
} from "@/lib/utils/discord-helpers";
import type {
  DiscordConnectionStatus,
  DiscordChannelInfo,
  OAuthState,
  SendMessageResult,
  DiscordEmbed,
  DiscordActionRow,
} from "./types";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const DISCORD_CDN_BASE = "https://cdn.discordapp.com";

// Required environment variables
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://www.elizacloud.ai";

// OAuth2 scopes and permissions
const OAUTH_SCOPES = "bot";
// Permissions: Send Messages (2048) + Embed Links (16384) + Read Message History (65536)
const BOT_PERMISSIONS = "83968";

class DiscordAutomationService {
  /**
   * Check if Discord OAuth is configured (has all required env vars for OAuth flow)
   * Use this for checking if users can add the bot to servers
   */
  isOAuthConfigured(): boolean {
    return Boolean(
      DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET && DISCORD_BOT_TOKEN,
    );
  }

  /**
   * Check if Discord bot can send messages (only needs bot token)
   * Use this for checking if posting/messaging will work
   */
  canSendMessages(): boolean {
    return Boolean(DISCORD_BOT_TOKEN);
  }

  /**
   * Check if Discord is configured (alias for isOAuthConfigured for backwards compatibility)
   * @deprecated Use isOAuthConfigured() or canSendMessages() instead
   */
  isConfigured(): boolean {
    return this.isOAuthConfigured();
  }

  /**
   * Generate OAuth2 URL for adding bot to a server
   */
  generateOAuthUrl(state: OAuthState): string {
    if (!DISCORD_CLIENT_ID) {
      throw new Error("Discord client ID not configured");
    }

    const stateEncoded = Buffer.from(JSON.stringify(state)).toString("base64");

    const params = new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      permissions: BOT_PERMISSIONS,
      scope: OAUTH_SCOPES,
      redirect_uri: `${APP_URL}/api/v1/discord/callback`,
      response_type: "code",
      state: stateEncoded,
    });

    return `https://discord.com/oauth2/authorize?${params.toString()}`;
  }

  /**
   * Handle Bot OAuth callback - uses guild_id directly from URL params
   * For bot OAuth (scope=bot), Discord returns guild_id in the callback URL
   */
  async handleBotOAuthCallback(
    guildId: string,
    stateBase64: string,
    permissions?: string,
  ): Promise<{
    success: boolean;
    guildId?: string;
    guildName?: string;
    error?: string;
  }> {
    if (!DISCORD_BOT_TOKEN) {
      return { success: false, error: "Discord bot token not configured" };
    }

    try {
      const state: OAuthState = JSON.parse(
        Buffer.from(stateBase64, "base64").toString(),
      );

      // Fetch guild info using bot token
      const guildResponse = await fetch(
        `${DISCORD_API_BASE}/guilds/${guildId}`,
        {
          headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          },
        },
      );

      if (!guildResponse.ok) {
        const errorText = await guildResponse.text();
        logger.error("[Discord] Failed to fetch guild info:", {
          guildId,
          status: guildResponse.status,
          error: errorText,
        });
        return {
          success: false,
          error:
            guildResponse.status === 403
              ? "Bot doesn't have access to this server"
              : "Failed to verify server access",
        };
      }

      const guild = await guildResponse.json();

      // Store guild in database
      await discordGuildsRepository.upsert({
        organization_id: state.organizationId,
        guild_id: guild.id,
        guild_name: guild.name,
        icon_hash: guild.icon,
        owner_id: state.userId,
        bot_permissions: permissions || BOT_PERMISSIONS,
      });

      // Fetch and cache channels
      await this.refreshChannels(state.organizationId, guild.id);

      logger.info("[Discord] Bot added to guild", {
        organizationId: state.organizationId,
        guildId: guild.id,
        guildName: guild.name,
      });

      return { success: true, guildId: guild.id, guildName: guild.name };
    } catch (error) {
      logger.error("[Discord] Bot OAuth callback error:", {
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return { success: false, error: "Authorization failed" };
    }
  }

  /**
   * Get connection status for an organization
   * Uses canSendMessages() to check if bot can actually post (only needs bot token)
   */
  async getConnectionStatus(
    organizationId: string,
  ): Promise<DiscordConnectionStatus> {
    // Check if bot can send messages (only needs DISCORD_BOT_TOKEN)
    if (!this.canSendMessages()) {
      return {
        connected: false,
        guilds: [],
        error: "Discord bot not configured",
      };
    }

    try {
      const guilds =
        await discordGuildsRepository.findByOrganization(organizationId);

      if (guilds.length === 0) {
        return { connected: false, guilds: [] };
      }

      // Get channel counts for each guild
      const guildsWithCounts = await Promise.all(
        guilds.map(async (guild) => {
          const channels = await discordChannelsRepository.findByGuild(
            organizationId,
            guild.guild_id,
          );
          return {
            id: guild.guild_id,
            name: guild.guild_name,
            iconUrl: getGuildIconUrl(guild.guild_id, guild.icon_hash),
            channelCount: channels.filter((c) => c.can_send_messages).length,
          };
        }),
      );

      return { connected: true, guilds: guildsWithCounts };
    } catch (error) {
      logger.error("[Discord] Status check error:", {
        organizationId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return { connected: false, guilds: [], error: "Failed to check status" };
    }
  }

  /**
   * Fetch and cache channels for a guild
   */
  async refreshChannels(
    organizationId: string,
    guildId: string,
  ): Promise<DiscordChannelInfo[]> {
    if (!DISCORD_BOT_TOKEN) {
      logger.error("[Discord] Bot token not configured");
      return [];
    }

    try {
      const response = await fetch(
        `${DISCORD_API_BASE}/guilds/${guildId}/channels`,
        {
          headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          },
        },
      );

      if (!response.ok) {
        const error = await response.text();
        logger.error("[Discord] Failed to fetch channels:", { guildId, error });
        return [];
      }

      const channels: DiscordChannelInfo[] = await response.json();

      // Filter to text channels only
      const textChannels = channels.filter((c) => isTextChannel(c.type));

      // Cache channels in database
      for (const channel of textChannels) {
        await discordChannelsRepository.upsert({
          organization_id: organizationId,
          guild_id: guildId,
          channel_id: channel.id,
          channel_name: channel.name,
          channel_type: channel.type,
          parent_id: channel.parent_id,
          position: channel.position,
          can_send_messages: true, // We'll assume we can send if we can see it
          is_nsfw: channel.nsfw ?? false,
        });
      }

      logger.info("[Discord] Channels refreshed", {
        organizationId,
        guildId,
        channelCount: textChannels.length,
      });

      return textChannels;
    } catch (error) {
      logger.error("[Discord] Channel refresh error:", {
        organizationId,
        guildId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return [];
    }
  }

  /**
   * Send a message to a Discord channel
   */
  async sendMessage(
    channelId: string,
    content: string,
    options?: {
      embeds?: DiscordEmbed[];
      components?: DiscordActionRow[];
    },
  ): Promise<SendMessageResult> {
    if (!DISCORD_BOT_TOKEN) {
      return { success: false, error: "Bot token not configured" };
    }

    try {
      // Split message if too long
      const chunks = splitMessage(
        content,
        DISCORD_RATE_LIMITS.MAX_MESSAGE_LENGTH,
      );
      let lastMessageId: string | undefined;

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const body: Record<string, unknown> = {
          content: chunks[i],
        };

        // Only add embeds and components to the last message
        if (isLast) {
          if (options?.embeds) body.embeds = options.embeds;
          if (options?.components) body.components = options.components;
        }

        const response = await Promise.race([
          fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("Discord API timeout")), 25_000),
          ),
        ]);

        if (!response.ok) {
          const error = await response.text();
          logger.error("[Discord] Failed to send message:", {
            channelId,
            error,
          });
          return { success: false, error: "Failed to send message" };
        }

        const message = await response.json();
        lastMessageId = message.id;
      }

      return { success: true, messageId: lastMessageId };
    } catch (error) {
      logger.error("[Discord] Send message error:", {
        channelId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return { success: false, error: "Failed to send message" };
    }
  }

  /**
   * Get guilds for an organization
   */
  async getGuilds(organizationId: string) {
    return discordGuildsRepository.findByOrganization(organizationId);
  }

  /**
   * Get channels for a guild
   */
  async getChannels(organizationId: string, guildId: string) {
    return discordChannelsRepository.findByGuild(organizationId, guildId);
  }

  /**
   * Get sendable channels for a guild
   */
  async getSendableChannels(organizationId: string, guildId: string) {
    return discordChannelsRepository.findSendableByGuild(
      organizationId,
      guildId,
    );
  }

  /**
   * Get a single guild
   */
  async getGuild(organizationId: string, guildId: string) {
    return discordGuildsRepository.findByGuildId(organizationId, guildId);
  }

  /**
   * Get a single channel
   */
  async getChannel(organizationId: string, channelId: string) {
    return discordChannelsRepository.findByChannelId(organizationId, channelId);
  }

  /**
   * Remove bot from guild (disconnect)
   */
  async disconnect(
    organizationId: string,
    guildId: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!DISCORD_BOT_TOKEN) {
      return { success: false, error: "Bot token not configured" };
    }

    try {
      // Try to leave the guild via API
      const response = await fetch(
        `${DISCORD_API_BASE}/users/@me/guilds/${guildId}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          },
        },
      );

      // Even if the API call fails (maybe already removed), clean up database
      if (!response.ok && response.status !== 404) {
        logger.warn(
          "[Discord] Failed to leave guild via API, cleaning up database anyway",
          {
            guildId,
            status: response.status,
          },
        );
      }

      // Remove from database
      await discordChannelsRepository.deleteByGuild(organizationId, guildId);
      await discordGuildsRepository.delete(organizationId, guildId);

      logger.info("[Discord] Disconnected from guild", {
        organizationId,
        guildId,
      });

      return { success: true };
    } catch (error) {
      logger.error("[Discord] Disconnect error:", {
        organizationId,
        guildId,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      return { success: false, error: "Failed to disconnect" };
    }
  }

  /**
   * Disconnect all guilds for an organization
   */
  async disconnectAll(organizationId: string): Promise<void> {
    const guilds = await this.getGuilds(organizationId);
    for (const guild of guilds) {
      await this.disconnect(organizationId, guild.guild_id);
    }
  }

  /**
   * Verify bot has access to a channel
   */
  async verifyChannelAccess(channelId: string): Promise<boolean> {
    if (!DISCORD_BOT_TOKEN) return false;

    try {
      const response = await fetch(
        `${DISCORD_API_BASE}/channels/${channelId}`,
        {
          headers: {
            Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          },
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const discordAutomationService = new DiscordAutomationService();

// Re-export types and app automation
export type {
  DiscordConnectionStatus,
  DiscordAutomationConfig,
  DiscordAutomationStatus,
  OAuthState,
  SendMessageResult,
  PostResult,
} from "./types";

export { discordAppAutomationService } from "./app-automation";
