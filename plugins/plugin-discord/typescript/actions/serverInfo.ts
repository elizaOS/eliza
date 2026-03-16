import type {
  Action,
  ActionExample,
  ActionResult,
  Content,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { Guild } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

const formatServerInfo = (guild: Guild, detailed: boolean = false): string => {
  const createdAt = new Date(guild.createdAt).toLocaleDateString();
  const memberCount = guild.memberCount.toLocaleString();
  const channelCount = guild.channels.cache.size.toLocaleString();
  const roleCount = guild.roles.cache.size.toLocaleString();
  const emojiCount = guild.emojis.cache.size.toLocaleString();
  const boostLevel = guild.premiumTier;
  const boostCount = (guild.premiumSubscriptionCount || 0).toLocaleString();

  const basicInfo = [
    `🏛️ **Server Information for ${guild.name}**`,
    `**ID:** ${guild.id}`,
    `**Owner:** <@${guild.ownerId}>`,
    `**Created:** ${createdAt}`,
    `**Members:** ${memberCount}`,
    `**Channels:** ${channelCount}`,
    `**Roles:** ${roleCount}`,
    `**Server Level:** ${boostLevel} (${boostCount} boosts)`,
  ];

  if (detailed) {
    const textChannels = guild.channels.cache
      .filter((ch) => ch.isTextBased())
      .size.toLocaleString();
    const voiceChannels = guild.channels.cache
      .filter((ch) => ch.isVoiceBased())
      .size.toLocaleString();
    const categories = guild.channels.cache.filter((ch) => ch.type === 4).size.toLocaleString(); // CategoryChannel type
    const activeThreads = guild.channels.cache
      .filter((ch) => ch.isThread() && !ch.archived)
      .size.toLocaleString();
    const stickerCount = guild.stickers.cache.size.toLocaleString();

    const features =
      guild.features.length > 0
        ? guild.features.map((f) => f.toLowerCase().replace(/_/g, " ")).join(", ")
        : "None";

    const detailedInfo = [
      "",
      "📊 **Detailed Statistics**",
      `**Text Channels:** ${textChannels}`,
      `**Voice Channels:** ${voiceChannels}`,
      `**Categories:** ${categories}`,
      `**Active Threads:** ${activeThreads}`,
      `**Custom Emojis:** ${emojiCount}`,
      `**Stickers:** ${stickerCount}`,
      "",
      "🎯 **Server Features**",
      `**Verification Level:** ${guild.verificationLevel}`,
      `**Content Filter:** ${guild.explicitContentFilter}`,
      `**2FA Requirement:** ${guild.mfaLevel === 1 ? "Enabled" : "Disabled"}`,
      `**Features:** ${features}`,
    ];

    if (guild.description) {
      detailedInfo.push(`**Description:** ${guild.description}`);
    }

    if (guild.vanityURLCode) {
      detailedInfo.push(`**Vanity URL:** discord.gg/${guild.vanityURLCode}`);
    }

    return [...basicInfo, ...detailedInfo].join("\n");
  }

  return basicInfo.join("\n");
};

const spec = requireActionSpec("SERVER_INFO");

export const serverInfo: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "discord";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const discordService = runtime.getService(DISCORD_SERVICE_NAME) as DiscordService;

    if (!discordService || !discordService.client) {
      if (callback) {
        await callback?.({
          text: "Discord service is not available.",
          source: "discord",
        });
      }
      return { success: false, error: "Discord service is not available" };
    }

    if (!state) {
      if (callback) {
        await callback?.({
          text: "State is not available.",
          source: "discord",
        });
      }
      return { success: false, error: "State is not available" };
    }

    try {
      const stateData = state.data;
      const room = stateData?.room || (await runtime.getRoom(message.roomId));
      const serverId = room?.messageServerId;
      if (!serverId) {
        if (callback) {
          await callback?.({
            text: "I couldn't determine the current server.",
            source: "discord",
          });
        }
        return { success: false, error: "Could not determine current server" };
      }

      const guild = await discordService.client.guilds.fetch(serverId);

      // Check if the request is for detailed info
      const messageContentText = message.content.text;
      const messageText = messageContentText?.toLowerCase() || "";
      const isDetailed =
        messageText.includes("detailed") ||
        messageText.includes("full") ||
        messageText.includes("stats") ||
        messageText.includes("statistics");

      const infoText = formatServerInfo(guild, isDetailed);

      const response: Content = {
        text: infoText,
        source: message.content.source,
      };

      if (callback) {
        await callback?.(response);
      }
      return { success: true, text: response.text };
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:server-info",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error getting server info"
      );
      if (callback) {
        await callback?.({
          text: "I encountered an error while getting server information. Please try again.",
          source: "discord",
        });
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default serverInfo;
