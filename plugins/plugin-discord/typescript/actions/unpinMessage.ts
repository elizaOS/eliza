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
import { type Message, PermissionsBitField, type TextChannel } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import { unpinMessageTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

const getMessageRef = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
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
    if (parsedResponse?.messageRef) {
      return {
        messageRef: String(parsedResponse.messageRef),
      };
    }
  }
  return null;
};

const spec = requireActionSpec("UNPIN_MESSAGE");

export const unpinMessage: Action = {
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

    const messageInfo = await getMessageRef(runtime, message, state);
    if (!messageInfo) {
      if (callback) {
        await callback?.({
          text: "I couldn't understand which message you want to unpin. Please be more specific.",
          source: "discord",
        });
      }
      return { success: false, error: "Could not parse message reference" };
    }

    try {
      const room = state.data?.room || (await runtime.getRoom(message.roomId));
      if (!room?.channelId) {
        if (callback) {
          await callback?.({
            text: "I couldn't determine the current channel.",
            source: "discord",
          });
        }
        return { success: false, error: "Could not determine current channel" };
      }

      const channel = await discordService.client.channels.fetch(room.channelId);
      if (!channel || !channel.isTextBased()) {
        if (callback) {
          await callback?.({
            text: "I can only unpin messages in text channels.",
            source: "discord",
          });
        }
        return { success: false, error: "Channel is not a text channel" };
      }

      const textChannel = channel as TextChannel;

      // Check bot permissions
      const clientUser = discordService.client.user;
      const botMember = textChannel.guild?.members.cache.get(clientUser?.id);
      if (botMember) {
        const permissions = textChannel.permissionsFor(botMember);
        if (permissions && !permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          if (callback) {
            await callback?.({
              text: "I don't have permission to unpin messages in this channel. I need the 'Manage Messages' permission.",
              source: "discord",
            });
          }
          return { success: false, error: "Missing ManageMessages permission" };
        }
      }

      let targetMessage: Message | null = null;

      // Get pinned messages
      const pinnedMessages = await textChannel.messages.fetchPinned();

      if (pinnedMessages.size === 0) {
        if (callback) {
          await callback?.({
            text: "There are no pinned messages in this channel.",
            source: "discord",
          });
        }
        return { success: true, text: "No pinned messages in channel" };
      }

      // Find the target message
      if (messageInfo.messageRef === "last_pinned" || messageInfo.messageRef === "last") {
        // Get the most recently created pinned message (since we can't sort by pin time)
        targetMessage = Array.from(pinnedMessages.values()).sort(
          (a, b) => b.createdTimestamp - a.createdTimestamp
        )[0];
      } else if (/^\d+$/.test(messageInfo.messageRef)) {
        // It's a message ID
        targetMessage = pinnedMessages.get(messageInfo.messageRef) || null;
      } else {
        // Search for message by content/author in pinned messages
        const searchLower = messageInfo.messageRef.toLowerCase();

        targetMessage =
          Array.from(pinnedMessages.values()).find((msg) => {
            const contentMatch = msg.content.toLowerCase().includes(searchLower);
            const authorMatch = msg.author.username.toLowerCase().includes(searchLower);
            return contentMatch || authorMatch;
          }) || null;
      }

      if (!targetMessage) {
        if (callback) {
          await callback?.({
            text: "I couldn't find a pinned message matching your description.",
            source: "discord",
          });
        }
        return { success: false, error: "Could not find matching pinned message" };
      }

      // Unpin the message
      try {
        await targetMessage.unpin();

        const response: Content = {
          text: `I've unpinned the message from ${targetMessage.author.username}.`,
          source: message.content.source,
        };

        if (callback) {
          await callback?.(response);
        }
        return { success: true, text: response.text };
      } catch (error) {
        runtime.logger.error(
          {
            src: "plugin:discord:action:unpin-message",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to unpin message"
        );
        if (callback) {
          await callback?.({
            text: "I couldn't unpin that message. Please try again.",
            source: "discord",
          });
        }
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:unpin-message",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error unpinning message"
      );
      if (callback) {
        await callback?.({
          text: "I encountered an error while trying to unpin the message. Please make sure I have the necessary permissions.",
          source: "discord",
        });
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default unpinMessage;
