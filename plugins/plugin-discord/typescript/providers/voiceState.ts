import { getVoiceConnection } from "@discordjs/voice";
import type { IAgentRuntime, Memory, Provider, ProviderResult, State, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import type { GuildChannel } from "discord.js";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";
import { ServiceType } from "../types";

const spec = requireProviderSpec("voiceState");

/**
 * Provides information about the voice state of the user, including whether they are currently in a voice channel.
 *
 * @param {IAgentRuntime} runtime - The runtime object for the agent
 * @param {Memory} message - The message object containing room ID
 * @param {State} [state] - Optional state object for the user
 * @returns {Object} An object containing information about the voice state of the user
 */
export const voiceStateProvider: Provider = {
  name: spec.name,
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Voice doesn't get a discord message, so we need to use the channel for guild data
    const room = await runtime.getRoom(message.roomId);
    if (!room) {
      throw new Error("No room found");
    }

    if (room.type !== ChannelType.GROUP) {
      // only handle in a group scenario for now
      return {
        data: {
          isInVoiceChannel: false,
          roomId: room.id,
        },
        values: {
          isInVoiceChannel: "false",
          roomType: room.type,
        },
        text: "",
      } as ProviderResult;
    }

    const channelId = room.channelId;
    const agentName = state?.agentName || "The agent";

    if (!channelId) {
      runtime.logger.warn(
        { src: "plugin:discord:provider:voiceState", roomId: room.id },
        "No channel ID found"
      );
      return {
        data: {
          isInVoiceChannel: false,
          roomId: room.id,
        },
        values: {
          isInVoiceChannel: "false",
          roomType: room.type,
        },
        text: `${agentName} is not currently in a voice channel`,
      } as ProviderResult;
    }

    // Look up guild via channel to get the Discord guild ID for voice connection
    const discordService = runtime.getService(ServiceType.DISCORD) as DiscordService;
    if (!discordService || !discordService.client) {
      runtime.logger.warn(
        { src: "plugin:discord:provider:voiceState" },
        "Discord service not available"
      );
      return {
        data: {
          isInVoiceChannel: false,
          roomId: room.id,
        },
        values: {
          isInVoiceChannel: "false",
        },
        text: `${agentName} is not currently in a voice channel`,
      } as ProviderResult;
    }

    // Try cache first, then fetch if not cached (handles cold start / partial cache scenarios)
    let channel = discordService.client.channels.cache.get(channelId) as GuildChannel | undefined;
    if (!channel) {
      try {
        channel = (await discordService.client.channels.fetch(channelId)) as
          | GuildChannel
          | undefined;
      } catch (fetchError) {
        runtime.logger.debug(
          {
            src: "plugin:discord:provider:voiceState",
            channelId,
            error: fetchError instanceof Error ? fetchError.message : String(fetchError),
          },
          "Failed to fetch channel"
        );
      }
    }
    const guildId = channel?.guild?.id;

    if (!guildId) {
      runtime.logger.warn(
        { src: "plugin:discord:provider:voiceState", channelId },
        "Could not find guild for channel (not in cache and fetch failed)"
      );
      return {
        data: {
          isInVoiceChannel: false,
          roomId: room.id,
        },
        values: {
          isInVoiceChannel: "false",
        },
        text: `${agentName} is not currently in a voice channel`,
      } as ProviderResult;
    }

    const connection = getVoiceConnection(guildId);

    if (!connection) {
      return {
        data: {
          isInVoiceChannel: false,
          roomId: room.id,
        },
        values: {
          isInVoiceChannel: "false",
        },
        text: `${agentName} is not currently in a voice channel`,
      } as ProviderResult;
    }

    const worldId = room.worldId;

    // get the world from the runtime.getWorld
    const world = await runtime.getWorld(worldId as UUID);

    if (!world) {
      throw new Error("No world found");
    }

    const worldName = world.name;
    const roomType = room.type;
    const channelName = room.name;

    return {
      data: {
        isInVoiceChannel: true,
        roomId: room.id,
        worldId: world.id,
        channelId,
        channelName,
      },
      values: {
        isInVoiceChannel: "true",
        worldName,
        roomType,
        channelId,
        channelName,
      },
      text: `${agentName} is currently in the voice channel: ${channelName} (ID: ${channelId})`,
    } as ProviderResult;
  },
};

export default voiceStateProvider;
