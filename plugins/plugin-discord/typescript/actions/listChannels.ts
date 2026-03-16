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
import { DISCORD_SERVICE_NAME } from "../constants";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

const spec = requireActionSpec("LIST_CHANNELS");

export const listChannels: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "discord";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const discordService = runtime.getService(DISCORD_SERVICE_NAME) as DiscordService;

    if (!discordService || !discordService.client) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:list-channels",
          agentId: runtime.agentId,
        },
        "Discord service not found or not initialized"
      );
      return { success: false, error: "Discord service not available" };
    }

    try {
      // Get all allowed channels
      const allowedChannelIds = discordService.getAllowedChannels();

      if (allowedChannelIds.length === 0) {
        if (callback) {
          await callback?.({
            text: "I'm currently listening to all channels (no restrictions are set).",
            source: "discord",
          });
        }
        return { success: true, text: "Listening to all channels (no restrictions)" };
      }

      // Fetch channel information for each allowed channel
      const channelInfoPromises = allowedChannelIds.map(async (channelId) => {
        try {
          const client = discordService.client;
          const channel = client && (await client.channels.fetch(channelId));
          if (channel?.isTextBased() && !channel.isVoiceBased()) {
            const guild = "guild" in channel ? channel.guild : null;
            return {
              id: channelId,
              name: "name" in channel ? channel.name : "DM",
              mention: `<#${channelId}>`,
              server: guild?.name || "Direct Message",
            };
          }
        } catch (_e) {
          // Channel might have been deleted or bot lost access
          return {
            id: channelId,
            name: "Unknown",
            mention: channelId,
            server: "Unknown or Deleted",
          };
        }
        return null;
      });

      const channelInfos = (await Promise.all(channelInfoPromises)).filter(Boolean);

      // Format the response
      let responseText = `I'm currently listening to ${channelInfos.length} channel${channelInfos.length !== 1 ? "s" : ""}:\n\n`;

      // Group by server
      const channelsByServer = channelInfos.reduce(
        (acc, channel) => {
          if (!channel) {
            return acc;
          }
          if (!acc[channel.server]) {
            acc[channel.server] = [];
          }
          acc[channel.server].push(channel);
          return acc;
        },
        {} as Record<string, typeof channelInfos>
      );

      // Format by server
      for (const [serverName, channels] of Object.entries(channelsByServer)) {
        responseText += `**${serverName}**\n`;
        for (const channel of channels) {
          if (channel) {
            responseText += `• ${channel.name} (${channel.mention})\n`;
          }
        }
        responseText += "\n";
      }

      // Check if CHANNEL_IDS is set
      const envChannelIds = runtime.getSetting("CHANNEL_IDS") as string;
      if (envChannelIds) {
        responseText +=
          "\n*Some channels are configured in environment settings and cannot be removed dynamically.*";
      }

      const response: Content = {
        text: responseText.trim(),
        actions: ["LIST_CHANNELS_RESPONSE"],
        source: message.content.source,
      };

      if (callback) {
        await callback?.(response);
      }
      return { success: true, text: response.text };
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:list-channels",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error listing channels"
      );
      if (callback) {
        await callback?.({
          text: "I encountered an error while trying to list the channels. Please try again.",
          source: "discord",
        });
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default listChannels;
