import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  createUniqueUuid,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  MemoryType,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { BaseGuildVoiceChannel, TextChannel } from "discord.js";
import { ChannelType as DiscordChannelType } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import { joinChannelTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";
import type { VoiceManager } from "../voice";

/**
 * Get channel information from the user's request
 * @param {IAgentRuntime} runtime - The runtime object to interact with the agent.
 * @param {Memory} _message - The memory object containing the input message.
 * @param {State} state - The state of the conversation.
 * @returns {Promise<{channelIdentifier: string, isVoiceChannel: boolean} | null>} Channel info or null if not parseable.
 */
const getJoinChannelInfo = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<{ channelIdentifier: string; isVoiceChannel: boolean } | null> => {
  const prompt = composePromptFromState({
    state,
    template: joinChannelTemplate,
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
 * @param {string} currentServerId - The current server ID to search in
 * @param {boolean} isVoiceChannel - Whether to look for voice channels
 * @returns {Promise<TextChannel | BaseGuildVoiceChannel | null>} The found channel or null
 */
const findChannel = async (
  discordService: DiscordService,
  identifier: string,
  currentServerId?: string,
  isVoiceChannel?: boolean
): Promise<TextChannel | BaseGuildVoiceChannel | null> => {
  if (!discordService.client) {
    return null;
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
          ch?.name.toLowerCase() === identifier.toLowerCase() ||
          ch?.name.toLowerCase().replace(/[^a-z0-9 ]/g, "") ===
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

const spec = requireActionSpec("JOIN_CHANNEL");

export const joinChannel: Action = {
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
        { src: "plugin:discord:action:join-channel", agentId: runtime.agentId },
        "Discord service not found or not initialized"
      );
      return { success: false, error: "Discord service not available" };
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

    const channelInfo = await getJoinChannelInfo(runtime, message, state);
    if (!channelInfo) {
      runtime.logger.warn(
        { src: "plugin:discord:action:join-channel", agentId: runtime.agentId },
        "Could not parse channel information from message"
      );
      if (callback) {
        await callback?.({
          text: "I couldn't understand which channel you want me to join. Please specify the channel name or ID.",
          source: "discord",
        });
      }
      return { success: false, error: "Could not parse channel information" };
    }

    try {
      const stateData = state.data;
      const room = stateData?.room || (await runtime.getRoom(message.roomId));
      const currentServerId = room?.messageServerId;

      // First, try the user's approach - if they said voice/vc, look for voice channels
      const messageContentText = message.content.text;
      const messageText = messageContentText?.toLowerCase() || "";
      const isVoiceRequest =
        channelInfo.isVoiceChannel ||
        messageText.includes("voice") ||
        messageText.includes("vc") ||
        messageText.includes("hop in");

      // Find the channel (try voice first if it's a voice request)
      let targetChannel = isVoiceRequest
        ? await findChannel(discordService, channelInfo.channelIdentifier, currentServerId, true)
        : await findChannel(discordService, channelInfo.channelIdentifier, currentServerId, false);

      // If not found, try the opposite type
      if (!targetChannel) {
        targetChannel = isVoiceRequest
          ? await findChannel(discordService, channelInfo.channelIdentifier, currentServerId, false)
          : await findChannel(discordService, channelInfo.channelIdentifier, currentServerId, true);
      }

      if (!targetChannel) {
        // If the user is in a voice channel and no specific channel was found, join their voice channel
        if (isVoiceRequest && currentServerId) {
          const guild = discordService.client.guilds.cache.get(currentServerId);
          const members = guild?.members?.cache;
          const member = members?.find(
            (member) => createUniqueUuid(runtime, member.id) === message.entityId
          );

          const memberVoice = member?.voice;
          if (memberVoice?.channel) {
            targetChannel = member.voice.channel as BaseGuildVoiceChannel;
          }
        }
      }

      if (!targetChannel) {
        if (callback) {
          await callback?.({
            text: `I couldn't find a channel with the identifier "${channelInfo.channelIdentifier}". Please make sure the channel name or ID is correct and I have access to it.`,
            source: "discord",
          });
        }
        return { success: false, error: `Channel not found: ${channelInfo.channelIdentifier}` };
      }

      // Handle voice channels
      if (targetChannel.type === DiscordChannelType.GuildVoice) {
        const voiceChannel = targetChannel as BaseGuildVoiceChannel;
        const voiceManager = discordService.voiceManager as VoiceManager;

        if (!voiceManager) {
          if (callback) {
            await callback?.({
              text: "Voice functionality is not available at the moment.",
              source: "discord",
            });
          }
          return { success: false, error: "Voice functionality not available" };
        }

        // Join the voice channel
        await voiceManager.joinChannel(voiceChannel);

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: "discord",
              thought: `I joined the voice channel ${voiceChannel.name}`,
              actions: ["JOIN_VOICE_STARTED"],
            },
            metadata: {
              type: MemoryType.CUSTOM,
            },
          },
          "messages"
        );

        const response: Content = {
          text: `I've joined the voice channel ${voiceChannel.name}!`,
          actions: ["JOIN_CHANNEL_RESPONSE"],
          source: message.content.source,
        };

        if (callback) {
          await callback?.(response);
        }
        return { success: true, text: response.text };
      } else {
        // Handle text channels
        const textChannel = targetChannel as TextChannel;

        // Check if we're already listening to this channel
        const currentChannels = discordService.getAllowedChannels();
        if (currentChannels.includes(textChannel.id)) {
          if (callback) {
            await callback?.({
              text: `I'm already listening to ${textChannel.name} (<#${textChannel.id}>).`,
              source: "discord",
            });
          }
          return { success: true, text: `Already listening to ${textChannel.name}` };
        }

        // Add the channel to the allowed list
        const success = discordService.addAllowedChannel(textChannel.id);

        if (success) {
          const response: Content = {
            text: `I've started listening to ${textChannel.name} (<#${textChannel.id}>). I'll now respond to messages in that channel.`,
            actions: ["JOIN_CHANNEL_RESPONSE"],
            source: message.content.source,
          };

          if (callback) {
            await callback?.(response);
          }
          return { success: true, text: response.text };
        } else {
          if (callback) {
            await callback?.({
              text: `I couldn't add ${textChannel.name} to my listening list. Please try again.`,
              source: "discord",
            });
          }
          return { success: false, error: `Could not add ${textChannel.name} to listening list` };
        }
      }
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:join-channel",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error joining channel"
      );
      if (callback) {
        await callback?.({
          text: "I encountered an error while trying to join the channel. Please make sure I have the necessary permissions.",
          source: "discord",
        });
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default joinChannel;
