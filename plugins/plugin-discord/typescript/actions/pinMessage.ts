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
import {
  type Message,
  PermissionsBitField,
  type TextChannel,
} from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import type { DiscordService } from "../service";

import { pinMessageTemplate } from "../generated/prompts/typescript/prompts.js";

// Re-export for backwards compatibility
export { pinMessageTemplate };

const getMessageRef = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State,
): Promise<{
  messageRef: string;
} | null> => {
  const prompt = composePromptFromState({
    state,
    template: pinMessageTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response);
    if (parsedResponse && parsedResponse.messageRef) {
      return {
        messageRef: String(parsedResponse.messageRef),
      };
    }
  }
  return null;
};

export const pinMessage = {
  name: "PIN_MESSAGE",
  similes: [
    "PIN_MESSAGE",
    "PIN_MSG",
    "PIN_THIS",
    "PIN_THAT",
    "MAKE_PINNED",
    "ADD_PIN",
  ],
  description: "Pin an important message in a Discord channel.",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state: State) => {
    return message.content.source === "discord";
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
      await callback({
        text: "Discord service is not available.",
        source: "discord",
      });
      return;
    }

    const messageInfo = await getMessageRef(runtime, message, state);
    if (!messageInfo) {
      await callback({
        text: "I couldn't understand which message you want to pin. Please be more specific.",
        source: "discord",
      });
      return;
    }

    try {
      const stateData = state.data;
      const room = (stateData && stateData.room) || (await runtime.getRoom(message.roomId));
      if (!room || !room.channelId) {
        await callback({
          text: "I couldn't determine the current channel.",
          source: "discord",
        });
        return;
      }

      const channel = await discordService.client.channels.fetch(
        room.channelId,
      );
      if (!channel || !channel.isTextBased()) {
        await callback({
          text: "I can only pin messages in text channels.",
          source: "discord",
        });
        return;
      }

      const textChannel = channel as TextChannel;

      // Check bot permissions
      const textChannelGuild = textChannel.guild;
      const discordServiceClient = discordService.client;
      const discordServiceClientUser = discordServiceClient && discordServiceClient.user;
      const botMember = textChannelGuild && textChannelGuild.members.cache.get(
        discordServiceClientUser && discordServiceClientUser.id,
      );
      if (botMember) {
        const permissions = textChannel.permissionsFor(botMember);
        if (!permissions || !permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          await callback({
            text: "I don't have permission to pin messages in this channel. I need the 'Manage Messages' permission.",
            source: "discord",
          });
          return;
        }
      }

      let targetMessage: Message | null = null;

      // Find the target message
      if (
        messageInfo.messageRef === "last" ||
        messageInfo.messageRef === "previous"
      ) {
        // Get the last few messages - fetch max allowed by Discord API
        const messages = await textChannel.messages.fetch({ limit: 100 });
        const sortedMessages = Array.from(messages.values()).sort(
          (a, b) => b.createdTimestamp - a.createdTimestamp,
        );

        // Skip the bot's own message and the command message
        const discordServiceClient = discordService.client;
        const discordServiceClientUser = discordServiceClient && discordServiceClient.user;
        targetMessage =
          sortedMessages.find(
            (msg) =>
              msg.id !== message.content.id &&
              msg.author.id !== (discordServiceClientUser && discordServiceClientUser.id),
          ) || null;
      } else if (/^\d+$/.test(messageInfo.messageRef)) {
        // It's a message ID
        try {
          targetMessage = await textChannel.messages.fetch(
            messageInfo.messageRef,
          );
        } catch (_e) {
          // Message not found
        }
      } else {
        // Search for message by content/author - fetch max allowed by Discord API
        const messages = await textChannel.messages.fetch({ limit: 100 });
        const searchLower = messageInfo.messageRef.toLowerCase();

        targetMessage =
          Array.from(messages.values()).find((msg) => {
            const contentMatch = msg.content
              .toLowerCase()
              .includes(searchLower);
            const authorMatch = msg.author.username
              .toLowerCase()
              .includes(searchLower);
            return contentMatch || authorMatch;
          }) || null;
      }

      if (!targetMessage) {
        await callback({
          text: "I couldn't find the message you want to pin. Try being more specific or use 'last message'.",
          source: "discord",
        });
        return;
      }

      // Check if already pinned
      if (targetMessage.pinned) {
        await callback({
          text: "That message is already pinned.",
          source: "discord",
        });
        return;
      }

      // Pin the message
      try {
        await targetMessage.pin();

        const response: Content = {
          text: `I've pinned the message from ${targetMessage.author.username}.`,
          source: message.content.source,
        };

        await callback(response);
      } catch (error) {
        runtime.logger.error(
          {
            src: "plugin:discord:action:pin-message",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to pin message",
        );
        await callback({
          text: "I couldn't pin that message. The channel might have reached the maximum number of pinned messages (50).",
          source: "discord",
        });
      }
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:pin-message",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error pinning message",
      );
      await callback({
        text: "I encountered an error while trying to pin the message. Please make sure I have the necessary permissions.",
        source: "discord",
      });
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "pin that message",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll pin that message for you.",
          actions: ["PIN_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "pin the announcement john just made",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll find and pin john's announcement.",
          actions: ["PIN_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "pin the last message, it's important",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Pinning the last message to keep it visible.",
          actions: ["PIN_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
} as unknown as Action;

export default pinMessage;
