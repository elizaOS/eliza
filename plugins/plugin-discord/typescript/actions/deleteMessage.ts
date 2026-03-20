import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { Message, TextChannel } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import type { DiscordService } from "../service";

const deleteMessageTemplate = `You are helping to extract delete message parameters.

The user wants to delete a Discord message.

Recent conversation:
{{recentMessages}}

Extract the following:
1. messageId: The ID of the message to delete
2. channelRef: The channel where the message is (default: "current")

Respond with a JSON object like:
{
  "messageId": "123456789",
  "channelRef": "current"
}

Only respond with the JSON object, no other text.`;

interface DeleteMessageParams {
  messageId: string;
  channelRef?: string;
}

const deleteMessage: Action = {
  name: "DELETE_MESSAGE",
  similes: [
    "REMOVE_MESSAGE",
    "UNSEND_MESSAGE",
    "DELETE_DISCORD_MESSAGE",
  ],
  description: "Delete a message from a Discord channel",
  
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
    const discordService = (await runtime.getService(DISCORD_SERVICE_NAME)) as DiscordService;

    if (!discordService || !discordService.client) {
      await callback?.({
        text: "Discord service is not available.",
        source: "discord",
      });
      return { success: false, error: "Discord service not available" };
    }

    // Ensure state is available
    const currentState = state ?? (await runtime.composeState(message));
    
    // Use LLM to extract delete parameters
    const prompt = composePromptFromState({
      state: currentState,
      template: deleteMessageTemplate,
    });

    let deleteParams: DeleteMessageParams | null = null;

    for (let i = 0; i < 3; i++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response) as unknown as DeleteMessageParams | null;
      if (parsedResponse?.messageId) {
        deleteParams = parsedResponse;
        break;
      }
    }

    if (!deleteParams) {
      await callback?.({
        text: "I couldn't determine which message to delete.",
        source: "discord",
      });
      return { success: false, error: "Failed to extract delete parameters" };
    }

    try {
      // Get the channel
      let channel: TextChannel | null = null;
      
      if (!deleteParams.channelRef || deleteParams.channelRef === "current") {
        const channelId = message.content.channelId as string;
        if (channelId) {
          channel = discordService.client.channels.cache.get(channelId) as TextChannel;
        }
      } else {
        // Try to find channel by name or ID
        channel = discordService.client.channels.cache.find(
          (c) => c.id === deleteParams!.channelRef || 
                 (c.isTextBased() && 'name' in c && c.name === deleteParams!.channelRef)
        ) as TextChannel;
      }

      if (!channel || !channel.isTextBased()) {
        await callback?.({
          text: "I couldn't find the channel with that message.",
          source: "discord",
        });
        return { success: false, error: "Channel not found" };
      }

      // Fetch and delete the message
      const targetMessage = await channel.messages.fetch(deleteParams.messageId) as Message;
      
      if (!targetMessage) {
        await callback?.({
          text: "I couldn't find the message to delete.",
          source: "discord",
        });
        return { success: false, error: "Message not found" };
      }

      // Check if we have permission to delete
      // We can delete our own messages or messages in channels where we have MANAGE_MESSAGES
      const canDelete = 
        targetMessage.author.id === discordService.client.user?.id ||
        (channel.permissionsFor(discordService.client.user!)?.has('ManageMessages') ?? false);

      if (!canDelete) {
        await callback?.({
          text: "I don't have permission to delete that message.",
          source: "discord",
        });
        return { success: false, error: "No permission to delete message" };
      }

      await targetMessage.delete();

      await callback?.({
        text: "I've deleted the message.",
        source: "discord",
      });

      return {
        success: true,
        data: {
          messageId: deleteParams.messageId,
          channelId: channel.id,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await callback?.({
        text: `Failed to delete message: ${errorMessage}`,
        source: "discord",
      });
      return { success: false, error: errorMessage };
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Delete message 123456789",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll delete that message now.",
          actions: ["DELETE_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Remove that spam message",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll remove that message.",
          actions: ["DELETE_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default deleteMessage;
