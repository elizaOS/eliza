import {
  type Action,
  type ActionExample,
  type ActionResult,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { PermissionsBitField, type TextChannel } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import { channelInfoTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

/**
 * Get channel information from the user's request
 * @param {IAgentRuntime} runtime - The runtime object to interact with the agent.
 * @param {Memory} _message - The memory object containing the input message.
 * @param {State} state - The state of the conversation.
 * @returns {Promise<{channelIdentifier: string, messageCount: number} | null>} Channel info or null if not parseable.
 */
const getChannelInfo = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<{
  channelIdentifier: string;
  messageCount: number;
  summarize: boolean;
  focusUser: string | null;
} | null> => {
  const prompt = composePromptFromState({
    state,
    template: channelInfoTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response) as {
      channelIdentifier: string;
      messageCount: number;
      summarize?: boolean;
      focusUser?: string | null;
    } | null;

    if (parsedResponse?.channelIdentifier) {
      // Ensure messageCount is within bounds
      const messageCount = Math.min(Math.max(parsedResponse.messageCount || 10, 1), 50);
      return {
        channelIdentifier: parsedResponse.channelIdentifier,
        messageCount,
        summarize: parsedResponse.summarize || false,
        focusUser: parsedResponse.focusUser || null,
      };
    }
  }
  return null;
};

const spec = requireActionSpec("READ_CHANNEL");

export const readChannel: Action = {
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
        { src: "plugin:discord:action:read-channel", agentId: runtime.agentId },
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

    const channelInfo = await getChannelInfo(runtime, message, state);
    if (!channelInfo) {
      runtime.logger.warn(
        { src: "plugin:discord:action:read-channel", agentId: runtime.agentId },
        "Could not parse channel information from message"
      );
      if (callback) {
        await callback?.({
          text: "I couldn't understand which channel you want me to read from. Please specify the channel name or say 'this channel' for the current channel.",
          source: "discord",
        });
      }
      return { success: false, error: "Could not parse channel information" };
    }

    try {
      let targetChannel: TextChannel | null = null;
      const stateData = state.data;
      const room = stateData?.room || (await runtime.getRoom(message.roomId));

      // Determine the target channel
      if (
        channelInfo.channelIdentifier === "current" ||
        channelInfo.channelIdentifier === "this" ||
        channelInfo.channelIdentifier === "here"
      ) {
        // Use current channel
        if (room?.channelId) {
          targetChannel = (await discordService.client.channels.fetch(
            room.channelId
          )) as TextChannel;
        }
      } else if (channelInfo.channelIdentifier.match(/^\d+$/)) {
        // It's a channel ID
        targetChannel = (await discordService.client.channels.fetch(
          channelInfo.channelIdentifier
        )) as TextChannel;
      } else {
        // It's a channel name - search in the current server
        const serverId = room?.messageServerId;
        if (!serverId) {
          if (callback) {
            await callback?.({
              text: "I couldn't determine which server to search for that channel.",
              source: "discord",
            });
          }
          return { success: false, error: "Could not determine server" };
        }
        const guild = await discordService.client.guilds.fetch(serverId);
        const channels = await guild.channels.fetch();

        targetChannel =
          (channels.find(
            (channel) =>
              channel?.name.toLowerCase().includes(channelInfo.channelIdentifier.toLowerCase()) &&
              channel.isTextBased()
          ) as TextChannel | undefined) || null;
      }

      if (!targetChannel || !targetChannel.isTextBased()) {
        if (callback) {
          await callback?.({
            text: "I couldn't find that channel or I don't have access to it. Make sure the channel exists and I have permission to read messages there.",
            source: "discord",
          });
        }
        return { success: false, error: "Channel not found or not accessible" };
      }

      // Check permissions
      const targetChannelGuild = targetChannel.guild;
      const clientUser = discordService.client.user;
      const botMember = targetChannelGuild?.members.cache.get(clientUser?.id);
      if (botMember) {
        const permissions = targetChannel.permissionsFor(botMember);
        if (!permissions || !permissions.has(PermissionsBitField.Flags.ReadMessageHistory)) {
          if (callback) {
            await callback?.({
              text: "I don't have permission to read message history in that channel.",
              source: "discord",
            });
          }
          return { success: false, error: "Missing ReadMessageHistory permission" };
        }
      }

      // Fetch messages - get more for summarization to have better context
      // Discord API limits to 100 messages per fetch
      const requestedLimit = channelInfo.summarize
        ? Math.max(channelInfo.messageCount * 2, 50)
        : channelInfo.messageCount;
      const fetchLimit = Math.min(requestedLimit, 100);

      runtime.logger.debug(
        {
          src: "plugin:discord:action:read-channel",
          agentId: runtime.agentId,
          channelName: targetChannel.name,
          fetchLimit,
          requestedLimit,
          summarize: channelInfo.summarize,
          focusUser: channelInfo.focusUser,
        },
        "Fetching messages"
      );

      const messages = await targetChannel.messages.fetch({
        limit: fetchLimit,
      });

      if (messages.size === 0) {
        if (callback) {
          await callback?.({
            text: `No messages found in <#${targetChannel.id}>.`,
            source: "discord",
          });
        }
        return { success: true, text: `No messages found in channel` };
      }

      // If summarization is requested
      if (channelInfo.summarize) {
        const sortedMessages = Array.from(messages.values()).reverse();

        // Filter by user if specified
        const relevantMessages = channelInfo.focusUser
          ? sortedMessages.filter((msg) => {
              const focusUserLower = channelInfo.focusUser?.toLowerCase();
              const msgMember = msg.member;
              const msgMemberDisplayName = msgMember?.displayName;
              return (
                msg.author.username.toLowerCase().includes(focusUserLower || "") ||
                msgMemberDisplayName?.toLowerCase().includes(focusUserLower || "")
              );
            })
          : sortedMessages;

        if (channelInfo.focusUser && relevantMessages.length === 0) {
          if (callback) {
            await callback?.({
              text: `I couldn't find any messages from "${channelInfo.focusUser}" in the recent messages from <#${targetChannel.id}>.`,
              source: "discord",
            });
          }
          return { success: true, text: `No messages found from ${channelInfo.focusUser}` };
        }

        // Prepare messages for summarization
        const messagesToSummarize = relevantMessages
          .slice(0, channelInfo.messageCount)
          .map((msg) => ({
            author: msg.author.username,
            content: msg.content || "[No text content]",
            timestamp: new Date(msg.createdTimestamp).toLocaleString(),
          }));

        // Create a summary prompt
        const summaryPrompt = channelInfo.focusUser
          ? `Please summarize what ${channelInfo.focusUser} has been discussing based on these messages from the Discord channel "${targetChannel.name}":\n\n${messagesToSummarize
              .map((m) => `${m.author} (${m.timestamp}): ${m.content}`)
              .join(
                "\n\n"
              )}\n\nProvide a concise summary focusing on:\n1. Main topics ${channelInfo.focusUser} discussed\n2. Key points or proposals they made\n3. Any questions they asked or issues they raised\n\nIf ${channelInfo.focusUser} didn't appear in these messages, please note that.`
          : `Please summarize the recent conversation in the Discord channel "${targetChannel.name}" based on these messages:\n\n${messagesToSummarize
              .map((m) => `${m.author} (${m.timestamp}): ${m.content}`)
              .join(
                "\n\n"
              )}\n\nProvide a concise summary that includes:\n1. Main topics discussed\n2. Key decisions or conclusions\n3. Who contributed what (mention specific usernames)\n4. Any action items or next steps mentioned`;

        const summary = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: summaryPrompt,
        });

        const response: Content = {
          text: channelInfo.focusUser
            ? `Summary of what ${channelInfo.focusUser} has been discussing in <#${targetChannel.id}>:\n\n${summary}`
            : `Summary of recent conversation in <#${targetChannel.id}>:\n\n${summary}`,
          actions: ["READ_CHANNEL_RESPONSE"],
          source: message.content.source,
        };

        if (callback) {
          await callback?.(response);
        }
        return { success: true, text: response.text };
      } else {
        // Format messages for display (original behavior)
        const formattedMessages = Array.from(messages.values())
          .reverse() // Show oldest first
          .map((msg) => {
            const timestamp = new Date(msg.createdTimestamp).toLocaleString();
            const author = msg.author.username;
            const content = msg.content || "[No text content]";
            const attachments =
              msg.attachments.size > 0
                ? `\n📎 Attachments: ${msg.attachments.map((a) => a.name || "unnamed").join(", ")}`
                : "";

            return `**${author}** (${timestamp}):\n${content}${attachments}`;
          })
          .join("\n\n---\n\n");

        const response: Content = {
          text: `Here are the last ${messages.size} messages from <#${targetChannel.id}>:\n\n${formattedMessages}`,
          actions: ["READ_CHANNEL_RESPONSE"],
          source: message.content.source,
        };

        if (callback) {
          await callback?.(response);
        }
        return { success: true, text: response.text };
      }
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:read-channel",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error reading channel"
      );
      if (callback) {
        await callback?.({
          text: "I encountered an error while trying to read the channel messages. Please make sure I have the necessary permissions and try again.",
          source: "discord",
        });
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default readChannel;
