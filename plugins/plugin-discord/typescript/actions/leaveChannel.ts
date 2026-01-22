import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  createUniqueUuid,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  MemoryType,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import {
  BaseGuildVoiceChannel,
  ChannelType as DiscordChannelType,
  type TextChannel,
} from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import { leaveChannelTemplate } from "../generated/prompts/typescript/prompts.js";
import type { DiscordService } from "../service";
import type { VoiceManager } from "../voice";

/**
 * Get channel information from the user's request
 * @param {IAgentRuntime} runtime - The runtime object to interact with the agent.
 * @param {Memory} _message - The memory object containing the input message.
 * @param {State} state - The state of the conversation.
 * @returns {Promise<{channelIdentifier: string, isVoiceChannel: boolean} | null>} Channel info or null if not parseable.
 */
const getLeaveChannelInfo = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<{ channelIdentifier: string; isVoiceChannel: boolean } | null> => {
  const prompt = composePromptFromState({
    state,
    template: leaveChannelTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response) as {
      channelIdentifier: string;
      isVoiceChannel: boolean;
    } | null;

    if (parsedResponse?.channelIdentifier) {
      return parsedResponse;
    }
  }
  return null;
};

/**
 * Find a Discord channel by various identifiers
 * @param {DiscordService} discordService - The Discord service instance
 * @param {string} identifier - The channel identifier (name, ID, or mention)
 * @param {string} currentChannelId - The current channel ID if "current" is specified
 * @param {string} currentServerId - The current server ID to search in
 * @param {boolean} isVoiceChannel - Whether to look for voice channels
 * @returns {Promise<TextChannel | BaseGuildVoiceChannel | null>} The found channel or null
 */
const findChannel = async (
  discordService: DiscordService,
  identifier: string,
  currentChannelId?: string,
  currentServerId?: string,
  isVoiceChannel?: boolean
): Promise<TextChannel | BaseGuildVoiceChannel | null> => {
  if (!discordService.client) {
    return null;
  }

  // Handle "current" channel
  if (identifier === "current" && currentChannelId) {
    try {
      const channel = await discordService.client.channels.fetch(currentChannelId);
      if (isVoiceChannel && channel && channel.type === DiscordChannelType.GuildVoice) {
        return channel as BaseGuildVoiceChannel;
      } else if (!isVoiceChannel && channel && channel.isTextBased() && !channel.isVoiceBased()) {
        return channel as TextChannel;
      }
    } catch (_e) {
      // Current channel not found
    }
  }

  // Remove channel mention formatting if present
  const cleanId = identifier.replace(/[<#>]/g, "");

  try {
    // Try to fetch by ID first
    if (/^\d+$/.test(cleanId)) {
      try {
        const channel = await discordService.client.channels.fetch(cleanId);
        if (isVoiceChannel && channel && channel.type === DiscordChannelType.GuildVoice) {
          return channel as BaseGuildVoiceChannel;
        } else if (!isVoiceChannel && channel && channel.isTextBased() && !channel.isVoiceBased()) {
          return channel as TextChannel;
        }
      } catch (_e) {
        // ID not found, continue to name search
      }
    }

    // Search in the current server if available
    if (currentServerId) {
      const guild = await discordService.client.guilds.fetch(currentServerId);
      const channels = await guild.channels.fetch();

      // Search by channel name
      const channel = channels.find((ch) => {
        const nameMatch =
          ch?.name?.toLowerCase() === identifier.toLowerCase() ||
          ch?.name?.toLowerCase().replace(/[^a-z0-9 ]/g, "") ===
            identifier.toLowerCase().replace(/[^a-z0-9 ]/g, "");

        if (isVoiceChannel) {
          return nameMatch && ch.type === DiscordChannelType.GuildVoice;
        } else {
          return nameMatch && ch.isTextBased() && !ch.isVoiceBased();
        }
      });

      if (channel) {
        return channel as TextChannel | BaseGuildVoiceChannel;
      }
    }

    // Search in all guilds the bot is in
    const guilds = Array.from(discordService.client.guilds.cache.values());
    for (const guild of guilds) {
      try {
        const channels = await guild.channels.fetch();
        const channel = channels.find((ch) => {
          const nameMatch =
            ch?.name?.toLowerCase() === identifier.toLowerCase() ||
            ch?.name?.toLowerCase().replace(/[^a-z0-9 ]/g, "") ===
              identifier.toLowerCase().replace(/[^a-z0-9 ]/g, "");

          if (isVoiceChannel) {
            return nameMatch && ch.type === DiscordChannelType.GuildVoice;
          } else {
            return nameMatch && ch.isTextBased() && !ch.isVoiceBased();
          }
        });

        if (channel) {
          return channel as TextChannel | BaseGuildVoiceChannel;
        }
      } catch (_e) {
        // Continue searching in other guilds
      }
    }

    return null;
  } catch (_error) {
    // Standalone function - error handled by caller
    return null;
  }
};

import type { HandlerOptions } from "@elizaos/core";
import { requireActionSpec } from "../generated/specs/spec-helpers";

const spec = requireActionSpec("LEAVE_CHANNEL");

export const leaveChannel: Action = {
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
      runtime.logger.error(
        {
          src: "plugin:discord:action:leave-channel",
          agentId: runtime.agentId,
        },
        "Discord service not found or not initialized"
      );
      await callback?.({
        text: "Discord service is not available.",
        source: "discord",
      });
      return undefined;
    }

    const channelInfo = await getLeaveChannelInfo(runtime, message, state);

    try {
      const stateData = state.data;
      const room = stateData?.room || (await runtime.getRoom(message.roomId));
      const currentServerId = room?.messageServerId;
      const currentChannelId = room?.channelId;

      // Check if trying to leave voice without specifying channel
      const messageContentText = message.content.text;
      const messageText = messageContentText?.toLowerCase() || "";
      const isVoiceRequest =
        channelInfo?.isVoiceChannel ||
        messageText.includes("voice") ||
        messageText.includes("vc") ||
        messageText.includes("call");

      // If it's a generic voice leave request, handle current voice channel
      if (isVoiceRequest && (!channelInfo || channelInfo.channelIdentifier === "current")) {
        const voiceManager = discordService.voiceManager as VoiceManager;

        if (!voiceManager) {
          await callback?.({
            text: "Voice functionality is not available at the moment.",
            source: "discord",
          });
          return undefined;
        }

        if (currentServerId) {
          const guild = discordService.client.guilds.cache.get(currentServerId);
          const guildMembers = guild?.members;
          const guildMembersMe = guildMembers?.me;
          const guildMembersMeVoice = guildMembersMe?.voice;
          const voiceChannel = guildMembersMeVoice?.channel;

          if (!voiceChannel || !(voiceChannel instanceof BaseGuildVoiceChannel)) {
            await callback?.({
              text: "I'm not currently in a voice channel.",
              source: "discord",
            });
            return undefined;
          }

          const connection = voiceManager.getVoiceConnection(guild.id);
          if (!connection) {
            await callback?.({
              text: "No active voice connection found.",
              source: "discord",
            });
            return undefined;
          }

          voiceManager.leaveChannel(voiceChannel);

          await runtime.createMemory(
            {
              entityId: message.entityId,
              agentId: message.agentId,
              roomId: createUniqueUuid(runtime, voiceChannel.id),
              content: {
                source: "discord",
                thought: `I left the voice channel ${voiceChannel.name}`,
                actions: ["LEAVE_VOICE_STARTED"],
              },
              metadata: {
                type: MemoryType.CUSTOM,
              },
            },
            "messages"
          );

          await callback?.({
            text: `I've left the voice channel ${voiceChannel.name}.`,
            source: "discord",
          });
          return;
        }
      }

      if (!channelInfo) {
        runtime.logger.warn(
          {
            src: "plugin:discord:action:leave-channel",
            agentId: runtime.agentId,
          },
          "Could not parse channel information from message"
        );
        await callback?.({
          text: "I couldn't understand which channel you want me to leave. Please specify the channel name or ID.",
          source: "discord",
        });
        return undefined;
      }

      // Find the channel (try voice first if it's a voice request)
      let targetChannel = isVoiceRequest
        ? await findChannel(
            discordService,
            channelInfo.channelIdentifier,
            currentChannelId,
            currentServerId,
            true
          )
        : await findChannel(
            discordService,
            channelInfo.channelIdentifier,
            currentChannelId,
            currentServerId,
            false
          );

      // If not found, try the opposite type
      if (!targetChannel) {
        targetChannel = isVoiceRequest
          ? await findChannel(
              discordService,
              channelInfo.channelIdentifier,
              currentChannelId,
              currentServerId,
              false
            )
          : await findChannel(
              discordService,
              channelInfo.channelIdentifier,
              currentChannelId,
              currentServerId,
              true
            );
      }

      if (!targetChannel) {
        await callback?.({
          text: `I couldn't find a channel with the identifier "${channelInfo.channelIdentifier}". Please make sure the channel name or ID is correct.`,
          source: "discord",
        });
        return undefined;
      }

      // Handle voice channels
      if (targetChannel.type === DiscordChannelType.GuildVoice) {
        const voiceChannel = targetChannel as BaseGuildVoiceChannel;
        const voiceManager = discordService.voiceManager as VoiceManager;

        if (!voiceManager) {
          await callback?.({
            text: "Voice functionality is not available at the moment.",
            source: "discord",
          });
          return undefined;
        }

        const guild = voiceChannel.guild;
        const guildMembersMe = guild.members?.me;
        const guildMembersMeVoice = guildMembersMe?.voice;
        const currentVoiceChannel = guildMembersMeVoice?.channel;

        if (!currentVoiceChannel || currentVoiceChannel.id !== voiceChannel.id) {
          await callback?.({
            text: `I'm not currently in the voice channel ${voiceChannel.name}.`,
            source: "discord",
          });
          return undefined;
        }

        voiceManager.leaveChannel(voiceChannel);

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: createUniqueUuid(runtime, voiceChannel.id),
            content: {
              source: "discord",
              thought: `I left the voice channel ${voiceChannel.name}`,
              actions: ["LEAVE_VOICE_STARTED"],
            },
            metadata: {
              type: MemoryType.CUSTOM,
            },
          },
          "messages"
        );

        const response: Content = {
          text: `I've left the voice channel ${voiceChannel.name}.`,
          actions: ["LEAVE_CHANNEL_RESPONSE"],
          source: message.content.source,
        };

        await callback?.(response);
      } else {
        // Handle text channels
        const textChannel = targetChannel as TextChannel;

        // Check if we're listening to this channel
        const currentChannels = discordService.getAllowedChannels();
        if (!currentChannels.includes(textChannel.id)) {
          await callback?.({
            text: `I'm not currently listening to ${textChannel.name} (<#${textChannel.id}>).`,
            source: "discord",
          });
          return undefined;
        }

        // Remove the channel from the allowed list
        const success = discordService.removeAllowedChannel(textChannel.id);

        if (success) {
          const response: Content = {
            text: `I've stopped listening to ${textChannel.name} (<#${textChannel.id}>). I will no longer respond to messages in that channel.`,
            actions: ["LEAVE_CHANNEL_RESPONSE"],
            source: message.content.source,
          };

          await callback?.(response);
        } else {
          await callback?.({
            text: `I couldn't remove ${textChannel.name} from my listening list. This channel might be configured in my environment settings and cannot be removed dynamically.`,
            source: "discord",
          });
          return undefined;
        }
      }
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:leave-channel",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error leaving channel"
      );
      await callback?.({
        text: "I encountered an error while trying to leave the channel. Please try again.",
        source: "discord",
      });
      return undefined;
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default leaveChannel;
