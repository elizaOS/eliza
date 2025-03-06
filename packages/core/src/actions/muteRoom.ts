import { composePrompt } from "../prompts";
import logger from "../logger";
import { booleanFooter } from "../prompts";
import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelTypes,
  type State,
} from "../types";

export const shouldMuteTemplate = `# Task: Decide if {{agentName}} should mute this room and stop responding unless explicitly mentioned.

{{recentMessages}}

Should {{agentName}} mute this room and stop responding unless explicitly mentioned?

Respond with YES if:
- The user is being aggressive, rude, or inappropriate
- The user has directly asked {{agentName}} to stop responding or be quiet
- {{agentName}}'s responses are not well-received or are annoying the user(s)

Otherwise, respond with NO.
${booleanFooter}`;

export const muteRoomAction: Action = {
  name: "MUTE_ROOM",
  similes: [
    "MUTE_CHAT",
    "MUTE_CONVERSATION",
    "MUTE_ROOM",
    "MUTE_THREAD",
    "MUTE_CHANNEL",
  ],
  description:
    "Mutes a room, ignoring all messages unless explicitly mentioned. Only do this if explicitly asked to, or if you're annoying people.",
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const roomId = message.roomId;
    const roomState = await runtime.databaseAdapter.getParticipantUserState(
      roomId,
      runtime.agentId
    );
    return roomState !== "MUTED";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback,
    responses?: Memory[]
  ) => {
    async function _shouldMute(state: State): Promise<boolean> {
      const shouldMutePrompt = composePrompt({
        state,
        template: shouldMuteTemplate, // Define this template separately
      });

      const response = await runtime.useModel(ModelTypes.TEXT_SMALL, {
        runtime,
        prompt: shouldMutePrompt,
        stopSequences: [],
      });

      const cleanedResponse = response.trim().toLowerCase();

      // Handle various affirmative responses
      if (
        cleanedResponse === "true" ||
        cleanedResponse === "yes" ||
        cleanedResponse === "y" ||
        cleanedResponse.includes("true") ||
        cleanedResponse.includes("yes")
      ) {
        await runtime.getMemoryManager("messages").createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I will now mute this room",
            actions: ["MUTE_ROOM_STARTED"],
          },
          metadata: {
            type: "MUTE_ROOM",
          },
        });
        return true;
      }

      // Handle various negative responses
      if (
        cleanedResponse === "false" ||
        cleanedResponse === "no" ||
        cleanedResponse === "n" ||
        cleanedResponse.includes("false") ||
        cleanedResponse.includes("no")
      ) {
        await runtime.getMemoryManager("messages").createMemory({
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I decided to not mute this room",
            actions: ["MUTE_ROOM_FAILED"],
          },
          metadata: {
            type: "MUTE_ROOM",
          },
        });
      }

      // Default to false if response is unclear
      logger.warn(`Unclear boolean response: ${response}, defaulting to false`);
      return false;
    }

    if (await _shouldMute(state)) {
      await runtime.databaseAdapter.setParticipantUserState(
        message.roomId,
        runtime.agentId,
        "MUTED"
      );
    }

    const room = await runtime.databaseAdapter.getRoom(message.roomId);

    await runtime.getMemoryManager("messages").createMemory({
      entityId: message.entityId,
      agentId: message.agentId,
      roomId: message.roomId,
      content: {
        thought: "I muted the room " + room.name,
        actions: ["MUTE_ROOM_START"],
      },
    });
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, please mute this channel. No need to respond here for now.",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "Got it",
          actions: ["MUTE_ROOM"],
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "@{{name1}} we could really use your input on this",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, please mute this channel for the time being",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "Understood",
          actions: ["MUTE_ROOM"],
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Hey what do you think about this new design",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "",
          actions: ["IGNORE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} plz mute this room",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "np going silent",
          actions: ["MUTE_ROOM"],
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "whos going to the webxr meetup in an hour btw",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "",
          actions: ["IGNORE"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "too many messages here {{name2}}",
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "my bad ill mute",
          actions: ["MUTE_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "yo {{name2}} dont talk in here",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "sry",
          actions: ["MUTE_ROOM"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
