/**
 * Discord Provider - Bot API and Webhooks
 */

import type {
  PlatformPostOptions,
  PostContent,
  PostResult,
  SocialCredentials,
  SocialMediaProvider,
} from "@/lib/types/social-media";
import { DISCORD_API_BASE, discordBotHeaders } from "@/lib/utils/discord-api";
import { extractErrorMessage } from "@/lib/utils/error-handling";
import { logger } from "@/lib/utils/logger";
import { withRetry } from "../rate-limit";

interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  embeds?: DiscordEmbed[];
  attachments?: Array<{ url: string }>;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string; icon_url?: string };
}

interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  avatar: string | null;
  bot?: boolean;
}

async function discordApiRequest<T>(
  endpoint: string,
  botToken: string,
  options: RequestInit = {},
): Promise<T> {
  const { data } = await withRetry<T>(
    () =>
      fetch(`${DISCORD_API_BASE}${endpoint}`, {
        ...options,
        headers: {
          ...discordBotHeaders(botToken),
          ...options.headers,
        },
      }),
    async (response) => {
      const json = (await response.json()) as T & { code?: number; message?: string };
      if (json.code) throw new Error(json.message || `Discord error ${json.code}`);
      return json;
    },
    { platform: "discord", maxRetries: 3 },
  );
  return data;
}

async function webhookRequest<T>(webhookUrl: string, payload: Record<string, unknown>): Promise<T> {
  const url = webhookUrl.includes("?") ? `${webhookUrl}&wait=true` : `${webhookUrl}?wait=true`;
  const { data } = await withRetry<T>(
    () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
    async (response) => {
      const json = (await response.json()) as T & { code?: number; message?: string };
      if (json.code) throw new Error(json.message || `Webhook error ${json.code}`);
      return json;
    },
    { platform: "discord", maxRetries: 3 },
  );
  return data;
}

export const discordProvider: SocialMediaProvider = {
  platform: "discord",

  async validateCredentials(credentials: SocialCredentials) {
    // Webhook validation
    if (credentials.webhookUrl) {
      try {
        const response = await fetch(credentials.webhookUrl);
        if (!response.ok) {
          return { valid: false, error: "Invalid webhook URL" };
        }
        const data = (await response.json()) as { id: string; name: string };
        return {
          valid: true,
          accountId: data.id,
          username: data.name,
        };
      } catch (error) {
        return {
          valid: false,
          error: extractErrorMessage(error),
        };
      }
    }

    // Bot token validation
    if (!credentials.botToken) {
      return { valid: false, error: "Bot token or webhook URL required" };
    }

    try {
      const user = await discordApiRequest<DiscordUser>("/users/@me", credentials.botToken);

      return {
        valid: true,
        accountId: user.id,
        username: user.username,
        displayName: user.username,
        avatarUrl: user.avatar
          ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
          : undefined,
      };
    } catch (error) {
      return {
        valid: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async createPost(
    credentials: SocialCredentials,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult> {
    try {
      // Build message payload
      const payload: Record<string, unknown> = {
        content: content.text,
      };

      // Add embed if provided
      if (options?.discord?.embed) {
        payload.embeds = [options.discord.embed];
      }

      // Add components if provided
      if (options?.discord?.components) {
        payload.components = options.discord.components;
      }

      // Handle media attachments
      // For embeds with images from URLs
      if (content.media?.length && !payload.embeds) {
        const embeds: DiscordEmbed[] = [];
        for (const media of content.media) {
          if (media.url && media.type === "image") {
            embeds.push({ image: { url: media.url } });
          }
        }
        if (embeds.length > 0) {
          payload.embeds = embeds;
        }
      }

      logger.info("[Discord] Creating post", {
        hasEmbed: !!payload.embeds,
        hasComponents: !!payload.components,
      });

      let message: DiscordMessage;

      // Use webhook if provided
      if (credentials.webhookUrl) {
        message = await webhookRequest<DiscordMessage>(credentials.webhookUrl, payload);
      } else if (credentials.botToken) {
        // Use bot token with channel ID
        const channelId = options?.discord?.channelId || credentials.channelId;
        if (!channelId) {
          return {
            platform: "discord",
            success: false,
            error: "Channel ID required for bot posting",
          };
        }

        message = await discordApiRequest<DiscordMessage>(
          `/channels/${channelId}/messages`,
          credentials.botToken,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
      } else {
        return {
          platform: "discord",
          success: false,
          error: "Bot token or webhook URL required",
        };
      }

      return {
        platform: "discord",
        success: true,
        postId: message.id,
        postUrl: `https://discord.com/channels/@me/${message.channel_id}/${message.id}`,
      };
    } catch (error) {
      logger.error("[Discord] Post failed", { error });
      return {
        platform: "discord",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async deletePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.botToken) {
      return { success: false, error: "Bot token required for deletion" };
    }

    // postId should be in format "channelId/messageId"
    const [channelId, messageId] = postId.includes("/")
      ? postId.split("/")
      : [credentials.channelId, postId];

    if (!channelId || !messageId) {
      return {
        success: false,
        error: "Invalid post ID format (expected channelId/messageId)",
      };
    }

    try {
      await discordApiRequest(
        `/channels/${channelId}/messages/${messageId}`,
        credentials.botToken,
        { method: "DELETE" },
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  async replyToPost(
    credentials: SocialCredentials,
    postId: string,
    content: PostContent,
    options?: PlatformPostOptions,
  ): Promise<PostResult> {
    if (!credentials.botToken) {
      return {
        platform: "discord",
        success: false,
        error: "Bot token required for replies",
      };
    }

    const [channelId, messageId] = postId.includes("/")
      ? postId.split("/")
      : [credentials.channelId, postId];

    if (!channelId || !messageId) {
      return {
        platform: "discord",
        success: false,
        error: "Invalid post ID format",
      };
    }

    try {
      const payload: Record<string, unknown> = {
        content: content.text,
        message_reference: { message_id: messageId },
      };

      if (options?.discord?.embed) {
        payload.embeds = [options.discord.embed];
      }

      const message = await discordApiRequest<DiscordMessage>(
        `/channels/${channelId}/messages`,
        credentials.botToken,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );

      return {
        platform: "discord",
        success: true,
        postId: message.id,
        postUrl: `https://discord.com/channels/@me/${channelId}/${message.id}`,
      };
    } catch (error) {
      return {
        platform: "discord",
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },

  // Discord doesn't have public likes/reactions in the same way
  async likePost(credentials: SocialCredentials, postId: string) {
    if (!credentials.botToken) {
      return { success: false, error: "Bot token required" };
    }

    const [channelId, messageId] = postId.includes("/")
      ? postId.split("/")
      : [credentials.channelId, postId];

    if (!channelId || !messageId) {
      return { success: false, error: "Invalid post ID format" };
    }

    try {
      // Add a reaction (default: thumbs up)
      await discordApiRequest(
        `/channels/${channelId}/messages/${messageId}/reactions/%F0%9F%91%8D/@me`,
        credentials.botToken,
        { method: "PUT" },
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: extractErrorMessage(error),
      };
    }
  },
};
