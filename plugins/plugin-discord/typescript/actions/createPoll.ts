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
import type { TextChannel } from "discord.js";
import { DISCORD_SERVICE_NAME } from "../constants";
import type { DiscordService } from "../service";

// Import generated prompts
import { createPollTemplate } from "../generated/prompts/typescript/prompts.js";

const getPollInfo = async (
  runtime: IAgentRuntime,
  _message: Memory,
  state: State,
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
      parsedResponse && parsedResponse.question &&
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

export const createPoll = {
  name: "CREATE_POLL",
  similes: [
    "CREATE_POLL",
    "MAKE_POLL",
    "START_POLL",
    "CREATE_VOTE",
    "MAKE_VOTE",
    "START_VOTE",
    "CREATE_SURVEY",
  ],
  description: "Create a poll in Discord with emoji reactions for voting.",
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

    const pollInfo = await getPollInfo(runtime, message, state);
    if (!pollInfo) {
      await callback({
        text: "I couldn't understand the poll details. Please specify a question and at least 2 options.",
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
          text: "I can only create polls in text channels.",
          source: "discord",
        });
        return;
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
        ...pollInfo.options.map(
          (option, index) => `${emojis[index]} ${option}`,
        ),
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
            "Failed to add reaction",
          );
        }
      }

      const response: Content = {
        text: `I've created a poll with ${pollInfo.options.length} options. Users can vote by clicking the reaction emojis!`,
        source: message.content.source,
      };

      await callback(response);
    } catch (error) {
      runtime.logger.error(
        {
          src: "plugin:discord:action:create-poll",
          agentId: runtime.agentId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Error creating poll",
      );
      await callback({
        text: "I encountered an error while creating the poll. Please make sure I have permission to send messages and add reactions.",
        source: "discord",
      });
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "create a poll: What game should we play tonight? Options: Minecraft, Fortnite, Valorant",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll create a poll for game selection with those options.",
          actions: ["CREATE_POLL"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "make a vote: Should we have the meeting at 3pm? Yes/No",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Creating a yes/no poll about the meeting time.",
          actions: ["CREATE_POLL"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "start a poll asking what day works best for everyone: Monday, Tuesday, Wednesday, Thursday, Friday",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "I'll create a poll to find the best day for everyone.",
          actions: ["CREATE_POLL"],
        },
      },
    ],
  ] as ActionExample[][],
} as unknown as Action;

export default createPoll;
