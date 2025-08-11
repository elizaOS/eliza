import { tool } from "ai";
import { z } from "zod";
import { Routes, ChannelType } from "discord-api-types/v10";
import { discordService } from "../services";

/**
 * Discord channel listing tool that fetches all channels from a server.
 *
 * Usage:
 * - List all channels: { serverId: "123456789012345678" }
 * - Filter by type: { serverId: "123456789012345678", type: "text" }
 * - With details: { serverId: "123456789012345678", includeDetails: true }
 *
 * Environment variables:
 * - DISCORD_SERVER_ID: Default server ID if not provided
 */

interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  position?: number;
  parent_id?: string | null;
  topic?: string | null;
  nsfw?: boolean;
  last_message_id?: string | null;
  bitrate?: number;
  user_limit?: number;
  rate_limit_per_user?: number;
  icon?: string | null;
  owner_id?: string;
  application_id?: string;
  managed?: boolean;
  archived?: boolean;
  auto_archive_duration?: number;
  locked?: boolean;
  invitable?: boolean;
  create_timestamp?: string | null;
}

const channelTypeMap: Record<string, number[]> = {
  text: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
  voice: [ChannelType.GuildVoice, ChannelType.GuildStageVoice],
  category: [ChannelType.GuildCategory],
  forum: [ChannelType.GuildForum],
  thread: [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ],
  dm: [ChannelType.DM, ChannelType.GroupDM],
  all: [],
};

export const listChannels = tool({
  description: "List Discord channels from a server using REST API",
  inputSchema: z.object({
    serverId: z
      .string()
      .optional()
      .describe(
        "The Discord server/guild ID. Uses DISCORD_SERVER_ID env var if not provided",
      ),
    type: z
      .enum(["text", "voice", "category", "forum", "thread", "dm", "all"])
      .default("all")
      .describe("Filter channels by type"),
    includeDetails: z
      .boolean()
      .default(false)
      .describe(
        "Include additional channel details like topic, user limits, etc.",
      ),
    includeThreads: z
      .boolean()
      .default(false)
      .describe("Include active threads in the channel list"),
    sortBy: z
      .enum(["name", "position", "type", "created"])
      .default("position")
      .describe("How to sort the channels"),
  }),
  execute: async ({
    serverId,
    type,
    includeDetails,
    includeThreads,
    sortBy,
  }) => {
    try {
      // Get the REST client from the service (must be already initialized)
      const rest = discordService.getRestClient();

      // Determine the guild ID
      const guildId = serverId || process.env.DISCORD_SERVER_ID;

      if (!guildId) {
        return {
          success: false,
          error:
            "Server ID is required. Set DISCORD_SERVER_ID env var or provide serverId parameter.",
          channels: [],
        };
      }

      // Fetch all channels in the guild
      const channels = (await rest.get(
        Routes.guildChannels(guildId),
      )) as DiscordChannel[];

      if (!channels || channels.length === 0) {
        return {
          success: true,
          serverId: guildId,
          channelCount: 0,
          channels: [],
          message: "No channels found in the server.",
        };
      }

      // Filter channels by type if specified
      let filteredChannels = channels;
      if (type !== "all") {
        const typeFilter = channelTypeMap[type];
        if (typeFilter && typeFilter.length > 0) {
          filteredChannels = channels.filter((ch) =>
            typeFilter.includes(ch.type),
          );
        }
      }

      // Fetch threads if requested
      let threads: DiscordChannel[] = [];
      if (includeThreads && type !== "dm") {
        try {
          // Fetch active threads
          const activeThreadsResponse = (await rest.get(
            Routes.guildActiveThreads(guildId),
          )) as { threads: DiscordChannel[] };
          threads = activeThreadsResponse.threads || [];

          // Add threads to the channel list if we're showing all types or specifically threads
          if (type === "all" || type === "thread") {
            filteredChannels = [...filteredChannels, ...threads];
          }
        } catch (error) {
          console.warn("Failed to fetch threads:", error);
        }
      }

      // Sort channels
      const sortedChannels = [...filteredChannels].sort((a, b) => {
        switch (sortBy) {
          case "name":
            return (a.name || "").localeCompare(b.name || "");
          case "position":
            return (a.position || 0) - (b.position || 0);
          case "type":
            return a.type - b.type;
          case "created":
            // Discord snowflake IDs encode creation time
            return BigInt(a.id) > BigInt(b.id) ? 1 : -1;
          default:
            return 0;
        }
      });

      // Format channel information
      const formattedChannels = sortedChannels.map((channel) => {
        const baseInfo: any = {
          id: channel.id,
          name: channel.name || "Unknown",
          type: getChannelTypeName(channel.type),
          position: channel.position,
        };

        if (includeDetails) {
          // Add additional details based on channel type
          if (channel.topic) baseInfo.topic = channel.topic;
          if (channel.parent_id) baseInfo.parentId = channel.parent_id;
          if (channel.nsfw !== undefined) baseInfo.nsfw = channel.nsfw;
          if (channel.rate_limit_per_user)
            baseInfo.slowmode = channel.rate_limit_per_user;

          // Voice channel specific
          if (
            channel.type === ChannelType.GuildVoice ||
            channel.type === ChannelType.GuildStageVoice
          ) {
            if (channel.bitrate) baseInfo.bitrate = channel.bitrate;
            if (channel.user_limit) baseInfo.userLimit = channel.user_limit;
          }

          // Thread specific
          if (
            [
              ChannelType.PublicThread,
              ChannelType.PrivateThread,
              ChannelType.AnnouncementThread,
            ].includes(channel.type)
          ) {
            if (channel.archived !== undefined)
              baseInfo.archived = channel.archived;
            if (channel.locked !== undefined) baseInfo.locked = channel.locked;
            if (channel.auto_archive_duration)
              baseInfo.autoArchiveDuration = channel.auto_archive_duration;
          }
        }

        return baseInfo;
      });

      // Group channels by category for better organization
      const channelsByCategory = new Map<
        string | null,
        typeof formattedChannels
      >();
      const categoryMap = new Map<string, string>();

      // First, identify all categories
      formattedChannels
        .filter((ch) => ch.type === "Category")
        .forEach((cat) => categoryMap.set(cat.id, cat.name));

      // Group channels
      formattedChannels.forEach((channel) => {
        const parentId =
          sortedChannels.find((ch) => ch.id === channel.id)?.parent_id || null;
        const categoryName = parentId
          ? categoryMap.get(parentId) || "Unknown Category"
          : "No Category";

        if (!channelsByCategory.has(categoryName)) {
          channelsByCategory.set(categoryName, []);
        }
        channelsByCategory.get(categoryName)!.push(channel);
      });

      // Generate summary
      const typeCounts = formattedChannels.reduce(
        (acc, ch) => {
          acc[ch.type] = (acc[ch.type] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );

      const summary = {
        totalChannels: formattedChannels.length,
        byType: typeCounts,
        hasThreads: threads.length > 0 ? threads.length : undefined,
        categories: Array.from(channelsByCategory.keys()).filter(
          (k) => k !== "No Category",
        ),
      };

      return {
        success: true,
        serverId: guildId,
        channelCount: formattedChannels.length,
        channels: formattedChannels,
        channelsByCategory: includeDetails
          ? Object.fromEntries(channelsByCategory)
          : undefined,
        summary,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";

      // Check for common permission errors
      if (errorMessage.includes("403") || errorMessage.includes("Forbidden")) {
        return {
          success: false,
          error:
            "Bot does not have permission to view channels in this server.",
          serverId,
          channels: [],
        };
      }

      if (errorMessage.includes("404") || errorMessage.includes("Not Found")) {
        return {
          success: false,
          error: "Server not found or bot is not a member of this server.",
          serverId,
          channels: [],
        };
      }

      return {
        success: false,
        error: `Failed to list channels: ${errorMessage}`,
        serverId,
        channels: [],
      };
    }
  },
});

/**
 * Helper function to get human-readable channel type names
 */
function getChannelTypeName(type: number): string {
  switch (type) {
    case ChannelType.GuildText:
      return "Text";
    case ChannelType.DM:
      return "DM";
    case ChannelType.GuildVoice:
      return "Voice";
    case ChannelType.GroupDM:
      return "Group DM";
    case ChannelType.GuildCategory:
      return "Category";
    case ChannelType.GuildAnnouncement:
      return "Announcement";
    case ChannelType.AnnouncementThread:
      return "Announcement Thread";
    case ChannelType.PublicThread:
      return "Public Thread";
    case ChannelType.PrivateThread:
      return "Private Thread";
    case ChannelType.GuildStageVoice:
      return "Stage Voice";
    case ChannelType.GuildDirectory:
      return "Directory";
    case ChannelType.GuildForum:
      return "Forum";
    case ChannelType.GuildMedia:
      return "Media";
    default:
      return "Unknown";
  }
}
