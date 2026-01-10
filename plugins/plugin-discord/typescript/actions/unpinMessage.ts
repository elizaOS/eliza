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

import { unpinMessageTemplate } from "../generated/prompts/typescript/prompts.js";

// Re-export for backwards compatibility
export { unpinMessageTemplate };

const getMessageRef = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State,
): Promise<{
  messageRef: string;
} | null> => {
  const prompt = composePromptFromState({
    state,
    template: unpinMessageTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response);
    if (parsedResponse && parsedResponse.messageRef) {
      return {
        messageRef: parsedResponse.messageRef,
      };
    }
  }
  return null;
};

export const unpinMessage: Action = {
  name: "UNPIN_MESSAGE",
  similes: [
    "UNPIN_MESSAGE",
    "UNPIN_MSG",
    "UNPIN_THIS",
    "UNPIN_THAT",
    "REMOVE_PIN",
    "DELETE_PIN",
  ],
  description: "Unpin a message in a Discord channel.",
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
        text: "I couldn't understand which message you want to unpin. Please be more specific.",
        source: "discord",
      });
      return;
    }

    try {
      const room = (state.data && state.data.room) || (await runtime.getRoom(message.roomId));
      if (!(room && room.channelId)) {
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
          text: "I can only unpin messages in text channels.",
          source: "discord",
        });
        return;
      }

      const textChannel = channel as TextChannel;

      // Check bot permissions
      const clientUser = discordService.client.user;
      const botMember = (textChannel.guild && textChannel.guild.members.cache.get(
        clientUser && clientUser.id,
      ));
      if (botMember) {
        const permissions = textChannel.permissionsFor(botMember);
        if (permissions && !permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          await callback({
            text: "I don't have permission to unpin messages in this channel. I need the 'Manage Messages' permission.",
            source: "discord",
          });
          return;
        }
      }

      let targetMessage: Message | null = null;

      // Get pinned messages
      const pinnedMessages = await textChannel.messages.fetchPinned();

      if (pinnedMessages.size === 0) {
        await callback({
          text: "There are no pinned messages in this channel.",
          source: "discord",
        });
        return;
      }

      // Find the target message
      if (
        messageInfo.messageRef === "last_pinned" ||
        messageInfo.messageRef === "last"
      ) {
        // Get the most recently created pinned message (since we can't sort by pin time)
        targetMessage = Array.from(pinnedMessages.values()).sort(
          (a, b) => b.createdTimestamp - a.createdTimestamp,
        )[0];
      } else if (/^\d+$/.test(messageInfo.messageRef)) {
        // It's a message ID
        targetMessage = pinnedMessages.get(messageInfo.messageRef) || null;
      } else {
        // Search for message by content/author in pinned messages
        const searchLower = messageInfo.messageRef.toLowerCase();

        targetMessage =
          Array.from(pinnedMessages.values()).find((msg) => {
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
          text: "I couldn't find a pinned message matching your description.",
          source: "discord",
        });
        return;
      }

      // Unpin the message
      try {
        await targetMessage.unpin();

        const response: Content = {
          text: `I've unpinned the message from ${targetMessage.author.username}.`,
          source: message.content.source,
        };

        await callback(response);
      } catch (error) {
        runtime.logger.error(
          {
            src: "plugin:discord:action:unpin-message",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to unpin message",
        );
        await callback({
          text: "I couldn't unpin that message. Please try again.",
          source: "discord",
        });
      }
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:unpin-message",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error unpinning message",
      );
      await callback({
        text: "I encountered an error while trying to unpin the message. Please make sure I have the necessary permissions.",
        source: "discord",
      });
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "unpin the last pinned message",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll unpin the most recent pinned message.",
          actions: ["UNPIN_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "unpin the message about the old meeting schedule",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll find and unpin the message about the meeting schedule.",
          actions: ["UNPIN_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "remove the pin from john's announcement",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll unpin john's announcement.",
          actions: ["UNPIN_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

export default unpinMessage;
