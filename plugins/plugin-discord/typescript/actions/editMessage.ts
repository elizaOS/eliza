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

const editMessageTemplate = `You are helping to extract edit message parameters.

The user wants to edit an existing Discord message.

Recent conversation:
{{recentMessages}}

Extract the following:
1. messageId: The ID of the message to edit
2. newText: The new text content for the message
3. channelRef: The channel where the message is (default: "current")

Respond with a JSON object like:
{
  "messageId": "123456789",
  "newText": "The updated message text",
  "channelRef": "current"
}

Only respond with the JSON object, no other text.`;

interface EditMessageParams {
  messageId: string;
  newText: string;
  channelRef?: string;
}

const editMessage: Action = {
  name: "EDIT_MESSAGE",
  similes: [
    "UPDATE_MESSAGE",
    "MODIFY_MESSAGE",
    "CHANGE_MESSAGE",
    "EDIT_DISCORD_MESSAGE",
  ],
  description: "Edit an existing message in a Discord channel",
  
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
    
    // Use LLM to extract edit parameters
    const prompt = composePromptFromState({
      state: currentState,
      template: editMessageTemplate,
    });

    let editParams: EditMessageParams | null = null;

    for (let i = 0; i < 3; i++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsedResponse = parseJSONObjectFromText(response) as unknown as EditMessageParams | null;
      if (parsedResponse?.messageId && parsedResponse?.newText) {
        editParams = parsedResponse;
        break;
      }
    }

    if (!editParams) {
      await callback?.({
        text: "I couldn't determine which message to edit or what to change it to.",
        source: "discord",
      });
      return { success: false, error: "Failed to extract edit parameters" };
    }

    try {
      // Get the channel
      let channel: TextChannel | null = null;
      
      if (!editParams.channelRef || editParams.channelRef === "current") {
        const channelId = message.content.channelId as string;
        if (channelId) {
          channel = discordService.client.channels.cache.get(channelId) as TextChannel;
        }
      } else {
        // Try to find channel by name or ID
        channel = discordService.client.channels.cache.find(
          (c) => c.id === editParams!.channelRef || 
                 (c.isTextBased() && 'name' in c && c.name === editParams!.channelRef)
        ) as TextChannel;
      }

      if (!channel || !channel.isTextBased()) {
        await callback?.({
          text: "I couldn't find the channel to edit the message in.",
          source: "discord",
        });
        return { success: false, error: "Channel not found" };
      }

      // Fetch and edit the message
      const targetMessage = await channel.messages.fetch(editParams.messageId) as Message;
      
      if (!targetMessage) {
        await callback?.({
          text: "I couldn't find the message to edit.",
          source: "discord",
        });
        return { success: false, error: "Message not found" };
      }

      // Check if we can edit this message (must be our own message)
      if (targetMessage.author.id !== discordService.client.user?.id) {
        await callback?.({
          text: "I can only edit my own messages.",
          source: "discord",
        });
        return { success: false, error: "Cannot edit messages from other users" };
      }

      await targetMessage.edit(editParams.newText);

      await callback?.({
        text: `I've edited the message to: "${editParams.newText}"`,
        source: "discord",
      });

      return {
        success: true,
        data: {
          messageId: editParams.messageId,
          channelId: channel.id,
          newText: editParams.newText,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await callback?.({
        text: `Failed to edit message: ${errorMessage}`,
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
          text: "Edit message 123456789 to say 'Hello updated!'",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll edit that message now.",
          actions: ["EDIT_MESSAGE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Update the previous message to fix the typo",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll update that message.",
          actions: ["EDIT_MESSAGE"],
        },
      },
    ],
  ] as ActionExample[][],
};

export default editMessage;
