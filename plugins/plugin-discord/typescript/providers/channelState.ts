import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import type { GuildChannel } from "discord.js";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";
import { ServiceType } from "../types";

const spec = requireProviderSpec("channelState");

/**
 * Represents a provider for retrieving channel state information.
 * @type {Provider}
 * @property {string} name - The name of the channel state provider.
 * @property {Function} get - Asynchronous function that retrieves channel state information based on the provided runtime, message, and optional state parameters.
 * @param {IAgentRuntime} runtime - The agent runtime.
 * @param {Memory} message - The message object.
 * @param {State} [state] - Optional state object.
 * @returns {Promise<Object>} A promise that resolves to an object containing channel state data, values, and text.
 */
export const channelStateProvider: Provider = {
  name: spec.name,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    const room = state.data?.room ?? (await runtime.getRoom(message.roomId));
    if (!room) {
      throw new Error("No room found");
    }

    // if message source is not discord, return
    if (message.content.source !== "discord") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";
    const senderName = state?.senderName || "someone";

    let responseText = "";
    let channelType = "";
    let serverName = "";
    const channelId = room.channelId ?? "";

    if (room.type === ChannelType.DM) {
      channelType = "DM";
      responseText = `${agentName} is currently in a direct message conversation with ${senderName}. ${agentName} should engage in conversation, should respond to messages that are addressed to them and only ignore messages that seem to not require a response.`;
    } else {
      channelType = "GROUP";

      if (!channelId) {
        runtime.logger.error(
          {
            src: "plugin:discord:provider:channelState",
            agentId: runtime.agentId,
            roomId: room.id,
          },
          "No channel ID found"
        );
        return {
          data: {
            room,
            channelType,
          },
          values: {
            channelType,
          },
          text: "",
        };
      }

      const discordService = runtime.getService(ServiceType.DISCORD) as DiscordService;
      if (!discordService) {
        runtime.logger.warn(
          {
            src: "plugin:discord:provider:channelState",
            agentId: runtime.agentId,
            channelId,
          },
          "No discord client found"
        );
        return {
          data: {
            room,
            channelType,
            channelId,
          },
          values: {
            channelType,
            channelId,
          },
          text: "",
        };
      }

      // Look up guild via channel instead of serverId (which is now a UUID)
      // Try cache first, then fetch if not cached (handles cold start / partial cache scenarios)
      let channel = discordService.client?.channels.cache.get(channelId) as
        | GuildChannel
        | undefined;
      if (!channel && discordService.client) {
        try {
          channel = (await discordService.client.channels.fetch(channelId)) as
            | GuildChannel
            | undefined;
        } catch (fetchError) {
          runtime.logger.debug(
            {
              src: "plugin:discord:provider:channelState",
              agentId: runtime.agentId,
              channelId,
              error: fetchError instanceof Error ? fetchError.message : String(fetchError),
            },
            "Failed to fetch channel"
          );
        }
      }
      const guild = channel?.guild;
      if (!guild) {
        runtime.logger.warn(
          {
            src: "plugin:discord:provider:channelState",
            agentId: runtime.agentId,
            channelId,
          },
          "Guild not found for channel (not in cache and fetch failed)"
        );
        return {
          data: {
            room,
            channelType,
            channelId,
          },
          values: {
            channelType,
            channelId,
          },
          text: "",
        };
      }
      serverName = guild.name;

      responseText = `${agentName} is currently having a conversation in the channel \`#${channel?.name || channelId}\` in the server \`${serverName}\``;
      responseText += `\n${agentName} is in a room with other users and should be self-conscious and only participate when directly addressed or when the conversation is relevant to them.`;
    }

    return {
      data: {
        room,
        channelType,
        serverName,
        channelId,
      },
      values: {
        channelType,
        serverName,
        channelId,
      },
      text: responseText,
    };
  },
};

export default channelStateProvider;
