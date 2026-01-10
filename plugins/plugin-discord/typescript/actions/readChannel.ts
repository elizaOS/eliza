import {
  type Action,
  type ActionExample,
  type Content,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { PermissionsBitField, type TextChannel } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import type { DiscordService } from "../service";

/**
 * Template for extracting channel information from the user's request.
 *
 * @type {string}
 * @description This template is used to determine which channel the user wants to read messages from,
 * and optionally how many messages to retrieve.
 *
 * @param {string} recentMessages - Placeholder for recent messages related to the request.
 * @param {string} senderName - Name of the sender requesting channel messages.
 *
 * @returns {string} - Formatted template with instructions and JSON structure for response.
 */
export const channelInfoTemplate = `# Messages we are searching for channel information
  {{recentMessages}}
  
  # Instructions: {{senderName}} is requesting to read messages from a specific Discord channel. Your goal is to determine:
  1. The channel they want to read from (could be the current channel or a mentioned channel)
  2. How many messages they want to read (default to 10 if not specified)
  3. Whether they want a summary or just the messages
  4. If they're looking for messages from a specific person
  
  If they say "this channel" or "here", use the current channel.
  If they mention a specific channel name or ID, extract that.
  If they ask to "summarize" or mention what someone is "talking about", set summarize to true.
  
  Your response must be formatted as a JSON block with this structure:
  \`\`\`json
  {
    "channelIdentifier": "<current|channel-name|channel-id>",
    "messageCount": <number between 1 and 50>,
    "summarize": true/false,
    "focusUser": "<username or null>"
  }
  \`\`\`
  `;

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
  state: State,
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

    if (parsedResponse && parsedResponse.channelIdentifier) {
      // Ensure messageCount is within bounds
      const messageCount = Math.min(
        Math.max(parsedResponse.messageCount || 10, 1),
        50,
      );
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

export const readChannel: Action = {
  name: "READ_CHANNEL",
  similes: [
    "READ_MESSAGES",
    "GET_CHANNEL_MESSAGES",
    "FETCH_MESSAGES",
    "SHOW_CHANNEL_HISTORY",
    "GET_CHAT_HISTORY",
    "READ_CHAT",
  ],
  description:
    "Reads recent messages from a Discord channel and either returns them or provides a summary. Can focus on messages from a specific user.",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    if (message.content.source !== "discord") {
      return false;
    }
    return true;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    _options: any,
    callback: HandlerCallback,
  ) => {
    const discordService = runtime.getService(
      DISCORD_SERVICE_NAME,
    ) as DiscordService;

    if (!discordService || !discordService.client) {
      runtime.logger.error(
        { src: "plugin:discord:action:read-channel", agentId: runtime.agentId },
        "Discord service not found or not initialized",
      );
      return;
    }

    const channelInfo = await getChannelInfo(runtime, message, state);
    if (!channelInfo) {
      runtime.logger.warn(
        { src: "plugin:discord:action:read-channel", agentId: runtime.agentId },
        "Could not parse channel information from message",
      );
      await callback({
        text: "I couldn't understand which channel you want me to read from. Please specify the channel name or say 'this channel' for the current channel.",
        source: "discord",
      });
      return;
    }

    try {
      let targetChannel: TextChannel | null = null;
      const stateData = state.data;
      const room = (stateData && stateData.room) || (await runtime.getRoom(message.roomId));

      // Determine the target channel
      if (
        channelInfo.channelIdentifier === "current" ||
        channelInfo.channelIdentifier === "this" ||
        channelInfo.channelIdentifier === "here"
      ) {
        // Use current channel
        if (room && room.channelId) {
          targetChannel = (await discordService.client.channels.fetch(
            room.channelId,
          )) as TextChannel;
        }
      } else if (channelInfo.channelIdentifier.match(/^\d+$/)) {
        // It's a channel ID
        targetChannel = (await discordService.client.channels.fetch(
          channelInfo.channelIdentifier,
        )) as TextChannel;
      } else {
        // It's a channel name - search in the current server
        const serverId = room && room.messageServerId;
        if (!serverId) {
          await callback({
            text: "I couldn't determine which server to search for that channel.",
            source: "discord",
          });
          return;
        }
        const guild = await discordService.client.guilds.fetch(serverId);
        const channels = await guild.channels.fetch();

        targetChannel =
          (channels.find(
            (channel) =>
              channel && channel.name
                .toLowerCase()
                .includes(channelInfo.channelIdentifier.toLowerCase()) &&
              channel.isTextBased(),
          ) as TextChannel | undefined) || null;
      }

      if (!targetChannel || !targetChannel.isTextBased()) {
        await callback({
          text: "I couldn't find that channel or I don't have access to it. Make sure the channel exists and I have permission to read messages there.",
          source: "discord",
        });
        return;
      }

      // Check permissions
      const targetChannelGuild = targetChannel.guild;
      const clientUser = discordService.client.user;
      const botMember = targetChannelGuild && targetChannelGuild.members.cache.get(
        clientUser && clientUser.id,
      );
      if (botMember) {
        const permissions = targetChannel.permissionsFor(botMember);
        if (!permissions || !permissions.has(PermissionsBitField.Flags.ReadMessageHistory)) {
          await callback({
            text: "I don't have permission to read message history in that channel.",
            source: "discord",
          });
          return;
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
        "Fetching messages",
      );

      const messages = await targetChannel.messages.fetch({
        limit: fetchLimit,
      });

      if (messages.size === 0) {
        await callback({
          text: `No messages found in <#${targetChannel.id}>.`,
          source: "discord",
        });
        return;
      }

      // If summarization is requested
      if (channelInfo.summarize) {
        const sortedMessages = Array.from(messages.values()).reverse();

        // Filter by user if specified
        const relevantMessages = channelInfo.focusUser
          ? sortedMessages.filter((msg) => {
              const focusUserLower = channelInfo.focusUser && channelInfo.focusUser.toLowerCase();
              const msgMember = msg.member;
              const msgMemberDisplayName = msgMember && msgMember.displayName;
              return (
                msg.author.username.toLowerCase().includes(focusUserLower || "") ||
                (msgMemberDisplayName && msgMemberDisplayName.toLowerCase().includes(focusUserLower || ""))
              );
            })
          : sortedMessages;

        if (channelInfo.focusUser && relevantMessages.length === 0) {
          await callback({
            text: `I couldn't find any messages from "${channelInfo.focusUser}" in the recent messages from <#${targetChannel.id}>.`,
            source: "discord",
          });
          return;
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
                "\n\n",
              )}\n\nProvide a concise summary focusing on:\n1. Main topics ${channelInfo.focusUser} discussed\n2. Key points or proposals they made\n3. Any questions they asked or issues they raised\n\nIf ${channelInfo.focusUser} didn't appear in these messages, please note that.`
          : `Please summarize the recent conversation in the Discord channel "${targetChannel.name}" based on these messages:\n\n${messagesToSummarize
              .map((m) => `${m.author} (${m.timestamp}): ${m.content}`)
              .join(
                "\n\n",
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

        await callback(response);
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

        await callback(response);
      }
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:read-channel",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error reading channel",
      );
      await callback({
        text: "I encountered an error while trying to read the channel messages. Please make sure I have the necessary permissions and try again.",
        source: "discord",
      });
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Can you read the last 20 messages from this channel?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll read the last 20 messages from this channel for you.",
          actions: ["READ_CHANNEL"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "read the core-devs channel and summarize what shaw talking about",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll read the core-devs channel and summarize shaw's discussion.",
          actions: ["READ_CHANNEL"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me what's been said in #general",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Let me fetch the recent messages from #general.",
          actions: ["READ_CHANNEL"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Summarize the recent conversation in this channel",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll summarize the recent conversation in this channel.",
          actions: ["READ_CHANNEL"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Read messages here",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll read the recent messages from this channel.",
          actions: ["READ_CHANNEL"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default readChannel;
