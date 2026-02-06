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
// Import generated prompts
import { createPollTemplate } from "../generated/prompts/typescript/prompts.js";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { DiscordService } from "../service";

const getPollInfo = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State
): Promise<{
  question: string;
  options: string[];
  useEmojis: boolean;
} | null> => {
  const prompt = composePromptFromState({
    state,
    template: createPollTemplate,
  });

  for (let i = 0; i < 3; i++) {
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    const parsedResponse = parseJSONObjectFromText(response);
    if (
      parsedResponse?.question &&
      Array.isArray(parsedResponse.options) &&
      parsedResponse.options.length >= 2
    ) {
      return {
        question: String(parsedResponse.question),
        options: parsedResponse.options.slice(0, 10).map(String), // Max 10 options
        useEmojis: parsedResponse.useEmojis !== false, // Default to true
      };
    }
  }
  return null;
};

// Number emojis for poll options
const numberEmojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const letterEmojis = ["🇦", "🇧", "🇨", "🇩", "🇪", "🇫", "🇬", "🇭", "🇮", "🇯"];
const yesNoEmojis = ["✅", "❌"];

const spec = requireActionSpec("CREATE_POLL");

export const createPoll: Action = {
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

    const pollInfo = await getPollInfo(runtime, message, state);
    if (!pollInfo) {
      if (callback) {
        await callback?.({
          text: "I couldn't understand the poll details. Please specify a question and at least 2 options.",
          source: "discord",
        });
      }
      return { success: false, error: "Could not parse poll details" };
    }

    try {
      const stateData = state.data;
      const room = stateData?.room || (await runtime.getRoom(message.roomId));
      if (!room || !room.channelId) {
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
            text: "I can only create polls in text channels.",
            source: "discord",
          });
        }
        return { success: false, error: "Channel is not a text channel" };
      }

      const textChannel = channel as TextChannel;

      // Determine which emojis to use
      let emojis: string[];
      if (
        pollInfo.options.length === 2 &&
        pollInfo.options.some((opt) => opt.toLowerCase().includes("yes")) &&
        pollInfo.options.some((opt) => opt.toLowerCase().includes("no"))
      ) {
        emojis = yesNoEmojis;
      } else if (pollInfo.useEmojis) {
        emojis = numberEmojis.slice(0, pollInfo.options.length);
      } else {
        emojis = letterEmojis.slice(0, pollInfo.options.length);
      }

      // Format the poll message
      const pollMessage = [
        `📊 **POLL: ${pollInfo.question}**`,
        "",
        ...pollInfo.options.map((option, index) => `${emojis[index]} ${option}`),
        "",
        "_React to vote!_",
      ].join("\n");

      // Send the poll message
      const sentMessage = await textChannel.send(pollMessage);

      // Add reactions
      for (let i = 0; i < pollInfo.options.length; i++) {
        try {
          await sentMessage.react(emojis[i]);
          // Small delay to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 250));
        } catch (error) {
          runtime.logger.error(
            {
              src: "plugin:discord:action:create-poll",
              agentId: runtime.agentId,
              emoji: emojis[i],
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to add reaction"
          );
        }
      }

      const response: Content = {
        text: `I've created a poll with ${pollInfo.options.length} options. Users can vote by clicking the reaction emojis!`,
        source: message.content.source,
      };

      if (callback) {
        await callback?.(response);
      }
      return { success: true, text: response.text };
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:create-poll",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error creating poll"
      );
      if (callback) {
        await callback?.({
          text: "I encountered an error while creating the poll. Please make sure I have permission to send messages and add reactions.",
          source: "discord",
        });
      }
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};

export default createPoll;
