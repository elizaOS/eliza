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
import type { TextChannel } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

const sendMessageTemplate = `You are helping to extract send message parameters.

The user wants to send a message to a Discord channel.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message text to send
2. channelRef: The channel to send to (default: "current" for the current channel)

Respond with a JSON object like:
{
  "text": "The message to send",
  "channelRef": "current"
}

Only respond with the JSON object, no other text.`;

const spec = requireActionSpec("SEND_MESSAGE");

export const sendMessage: Action = {
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
      await callback?.({
        text: "Discord service is not available.",
        source: "discord",
      });
      return;
    }

    // Use LLM to extract message parameters
    const prompt = composePromptFromState({
      state,
      template: sendMessageTemplate,
    });

    let messageInfo: { text: string; channelRef?: string } | null = null;

    for (let i = 0; i < 3; i++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response);
      if (parsedResponse?.text) {
        messageInfo = {
          text: String(parsedResponse.text),
          channelRef: parsedResponse.channelRef ? String(parsedResponse.channelRef) : "current",
        };
        break;
      }
    }

    if (!messageInfo || !messageInfo.text) {
      runtime.logger.debug(
        { src: "plugin:discord:action:send-message" },
        "[SEND_MESSAGE] Could not extract message info"
      );
      await callback?.({
        text: "I couldn't understand what message you want me to send. Please try again with a clearer request.",
        source: "discord",
      });
      return;
    }

    try {
      const stateData = state?.data;
      const room = stateData?.room || (await runtime.getRoom(message.roomId));

      if (!room || !room.channelId) {
        await callback?.({
          text: "I couldn't determine the current channel.",
          source: "discord",
        });
        return;
      }

      let targetChannelId = room.channelId;

      // If a specific channel was referenced (not "current"), try to find it
      if (messageInfo.channelRef && messageInfo.channelRef !== "current") {
        const guild = discordService.client.guilds.cache.first();
        if (guild) {
          const channels = await guild.channels.fetch();
          const targetChannel = channels.find((ch) => {
            if (!ch || !ch.isTextBased()) return false;
            const channelName = ch.name?.toLowerCase() || "";
            const searchTerm = messageInfo?.channelRef?.toLowerCase() || "";
            return (
              channelName === searchTerm ||
              channelName.includes(searchTerm) ||
              ch.id === messageInfo?.channelRef
            );
          });
          if (targetChannel) {
            targetChannelId = targetChannel.id;
          }
        }
      }

      const channel = await discordService.client.channels.fetch(targetChannelId);
      if (!channel || !channel.isTextBased()) {
        await callback?.({
          text: "I can only send messages to text channels.",
          source: "discord",
        });
        return;
      }

      const textChannel = channel as TextChannel;

      // Send the message
      const sentMessage = await textChannel.send(messageInfo.text);

      const response: Content = {
        text: `Message sent successfully.`,
        source: message.content.source,
      };

      runtime.logger.debug(
        {
          src: "plugin:discord:action:send-message",
          messageId: sentMessage.id,
          channelId: targetChannelId,
        },
        "[SEND_MESSAGE] Message sent successfully"
      );

      await callback?.(response);

      return {
        success: true,
        data: {
          messageId: sentMessage.id,
          channelId: targetChannelId,
        },
      };
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:send-message",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error sending message"
      );
      await callback?.({
        text: "I encountered an error while trying to send the message. Please make sure I have the necessary permissions.",
        source: "discord",
      });
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default sendMessage;
