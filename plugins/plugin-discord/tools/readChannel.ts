import { tool } from "ai";
import { z } from "zod";
import { Routes } from "discord-api-types/v10";
import { discordService } from "../services";

/**
 * Discord channel reading tool that supports both channel IDs and natural channel names.
 *
 * Usage:
 * - With channel ID: { channel: "123456789012345678" }
 * - With channel name: { channel: "core-devs", serverId: "987654321" }
 * - Channel names are resolved case-insensitively and # prefix is optional
 *
 * Environment variables:
 * - DISCORD_SERVER_ID: Default server ID for channel name resolution
 */

interface DiscordMessage {
  id: string;
  channel_id: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    avatar?: string;
    bot?: boolean;
  };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  tts: boolean;
  mention_everyone: boolean;
  mentions: any[];
  mention_roles: string[];
  attachments: Array<{
    id: string;
    filename: string;
    size: number;
    url: string;
    proxy_url: string;
  }>;
  embeds: any[];
  reactions?: any[];
  pinned: boolean;
  type: number;
}

export const readChannel = tool({
  description: "Read messages from a Discord channel using REST API",
  inputSchema: z.object({
    channel: z
      .string()
      .describe(
        "The Discord channel name (e.g. 'core-devs', 'general') or channel ID",
      ),
    serverId: z
      .string()
      .optional()
      .describe(
        "The Discord server/guild ID (required when using channel name)",
      ),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(10)
      .describe("Number of messages to fetch (1-100)"),
    before: z
      .string()
      .optional()
      .describe("Get messages before this message ID"),
    after: z.string().optional().describe("Get messages after this message ID"),
    around: z
      .string()
      .optional()
      .describe("Get messages around this message ID"),
    summarize: z
      .boolean()
      .default(false)
      .describe("Whether to summarize the messages"),
  }),
  execute: async ({
    channel,
    serverId,
    limit,
    before,
    after,
    around,
    summarize,
  }) => {
    try {
      // Get the REST client from the service (must be already initialized)
      const rest = discordService.getRestClient();

      let channelId = channel;

      // Check if channel is a name (not a snowflake ID)
      if (!/^\d{17,19}$/.test(channel)) {
        // It's a channel name, we need to resolve it
        if (!serverId && !process.env.DISCORD_SERVER_ID) {
          return {
            success: false,
            error:
              "Server ID is required when using channel name. Set DISCORD_SERVER_ID env var or provide serverId parameter.",
            channelId: channel,
          };
        }

        const guildId = serverId || process.env.DISCORD_SERVER_ID;

        try {
          // Fetch all channels in the guild
          const channels = (await rest.get(
            Routes.guildChannels(guildId as string),
          )) as Array<{ id: string; name: string; type: number }>;

          // Find channel by name (case-insensitive, handle with or without #)
          const cleanChannelName = channel.replace(/^#/, "").toLowerCase();
          const foundChannel = channels.find(
            (ch) => ch.name.toLowerCase() === cleanChannelName,
          );

          if (!foundChannel) {
            const availableChannels = channels
              .filter((ch) => ch.type === 0 || ch.type === 2) // Text or voice channels
              .map((ch) => ch.name)
              .join(", ");
            return {
              success: false,
              error: `Channel '${channel}' not found in server. Available channels: ${availableChannels}`,
              channelId: channel,
            };
          }

          channelId = foundChannel.id;
        } catch (error) {
          return {
            success: false,
            error: `Failed to resolve channel name: ${error instanceof Error ? error.message : String(error)}`,
            channelId: channel,
          };
        }
      }

      // Build query parameters
      const params = new URLSearchParams();
      params.append("limit", limit.toString());
      if (before) params.append("before", before);
      if (after) params.append("after", after);
      if (around) params.append("around", around);

      // Fetch messages from Discord API
      const messages = (await rest.get(
        `${Routes.channelMessages(channelId)}?${params.toString()}`,
      )) as DiscordMessage[];

      if (!messages || messages.length === 0) {
        return {
          success: true,
          channelId,
          channelName: channel,
          messageCount: 0,
          messages: [],
          summary: summarize ? "No messages found in the channel." : undefined,
        };
      }

      // Format messages for output
      const formattedMessages = messages.map((msg) => ({
        id: msg.id,
        author: {
          id: msg.author.id,
          username: msg.author.username,
          isBot: msg.author.bot || false,
        },
        content: msg.content || "[No text content]",
        timestamp: msg.timestamp,
        attachments: msg.attachments.map((att) => ({
          filename: att.filename,
          size: att.size,
          url: att.url,
        })),
        mentions: msg.mentions.map((mention: any) => mention.username),
        pinned: msg.pinned,
      }));

      // Generate summary if requested
      let summary: string | undefined;
      if (summarize) {
        const topics = new Set<string>();
        const authors = new Map<string, number>();
        let totalMessages = formattedMessages.length;
        let hasAttachments = 0;
        let hasMentions = 0;

        formattedMessages.forEach((msg) => {
          // Count messages per author
          authors.set(
            msg.author.username,
            (authors.get(msg.author.username) || 0) + 1,
          );

          // Count attachments and mentions
          if (msg.attachments.length > 0) hasAttachments++;
          if (msg.mentions.length > 0) hasMentions++;

          // Extract potential topics (simple keyword extraction)
          const words = msg.content.toLowerCase().split(/\s+/);
          words.forEach((word) => {
            if (word.length > 5 && !word.startsWith("http")) {
              topics.add(word);
            }
          });
        });

        const topAuthors = Array.from(authors.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([name, count]) => `${name} (${count} messages)`)
          .join(", ");

        const oldestMessage = formattedMessages[formattedMessages.length - 1];
        const newestMessage = formattedMessages[0];

        summary = `Channel Summary:
- Total messages: ${totalMessages}
- Active users: ${topAuthors}
- Messages with attachments: ${hasAttachments}
- Messages with mentions: ${hasMentions}
- Time range: ${oldestMessage ? new Date(oldestMessage.timestamp).toLocaleString() : "N/A"} to ${newestMessage ? new Date(newestMessage.timestamp).toLocaleString() : "N/A"}`;
      }

      return {
        success: true,
        channelId,
        channelName: channel,
        messageCount: formattedMessages.length,
        messages: formattedMessages,
        summary,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      return {
        success: false,
        error: `Failed to read channel messages: ${errorMessage}`,
        channelId: channel,
      };
    }
  },
});
