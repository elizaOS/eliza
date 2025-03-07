import { composePrompt } from "../prompts";
import { booleanFooter, parseBooleanFromText } from "../prompts";
import {
  type Action,
  type ActionExample,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelTypes,
  type State,
} from "../types";

const shouldUnfollowTemplate = `# Task: Decide if {{agentName}} should stop closely following this previously followed room and only respond when mentioned.

{{recentMessages}}

Should {{agentName}} stop closely following this previously followed room and only respond when mentioned?
Respond with YES if:
- The user has suggested that {{agentName}} is over-participating or being disruptive
- {{agentName}}'s eagerness to contribute is not well-received by the users
- The conversation has shifted to a topic where {{agentName}} has less to add

Otherwise, respond with NO.
${booleanFooter}`;

export const unfollowRoomAction: Action = {
  name: "UNFOLLOW_ROOM",
  similes: [
    "UNFOLLOW_CHAT",
    "UNFOLLOW_CONVERSATION",
    "UNFOLLOW_ROOM",
    "UNFOLLOW_THREAD",
  ],
  description:
    "Stop following this channel. You can still respond if explicitly mentioned, but you won't automatically chime in anymore. Unfollow if you're annoying people or have been asked to.",
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const roomId = message.roomId;
    const roomState = await runtime.databaseAdapter.getParticipantUserState(
      roomId,
      runtime.agentId
    );
    return roomState === "FOLLOWED";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: { [key: string]: unknown },
    _callback?: HandlerCallback,
    _responses?: Memory[]
  ) => {
    async function _shouldUnfollow(state: State): Promise<boolean> {
      const shouldUnfollowPrompt = composePrompt({
        state,
        template: shouldUnfollowTemplate, // Define this template separately
      });

      const response = await runtime.useModel(ModelTypes.TEXT_SMALL, {
        prompt: shouldUnfollowPrompt,
      });

      const parsedResponse = parseBooleanFromText(response.trim());

      return parsedResponse;
    }

    if (await _shouldUnfollow(state)) {
      await runtime.databaseAdapter.setParticipantUserState(
        message.roomId,
        runtime.agentId,
        null
      );

      const room = state.data.room ?? await runtime.databaseAdapter.getRoom(message.roomId);

      await runtime.getMemoryManager("messages").createMemory({
        entityId: message.entityId,
        agentId: message.agentId,
        roomId: message.roomId,
        content: {
          thought: `I unfollowed the room ${room.name}`,
          actions: ["UNFOLLOW_ROOM_START"],
        },
      });
    } else {
      await runtime.getMemoryManager("messages").createMemory({
        entityId: message.entityId,
        agentId: message.agentId,
        roomId: message.roomId,
        content: {
          source: message.content.source,
          thought: "I tried to unfollow a room but I'm not in a room",
          actions: ["UNFOLLOW_ROOM_FAILED"],
        },
        metadata: {
          type: "UNFOLLOW_ROOM",
        },
      });
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Hey {{name2}} stop participating in this channel for now",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Alright, I will stop chiming in",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Has anyone tried the new update",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "Yes, it's pretty slick",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "{{name3}}, please stop following this chat",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "Understood",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "hey {{name3}} stop participating here so frequently",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "I'll only respond when mentioned",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "thoughts on the budget",
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}} should we increase it",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "A small increase could work given our past results...",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}}, unfollow this room for now",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "I'll only engage when asked",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "wait {{name3}} come back and give me your thoughts",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "Okay... I think it's intuitive, parallel tests are nice",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "yo {{name2}} chill on all the messages damn",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "my bad, I'll step back",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} STOP MESSAGING IN THIS ROOM",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "No problem, I've got other stuff to work on",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} ur bein annoyin pls stop",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "sry, ill chill",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}}, please cease engaging in this room",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "No sweat",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name2}}",
        content: {
          text: "Excited for the weekend, any plans folks",
        },
      },
      {
        name: "{{name1}}",
        content: {
          text: "{{name3}} you're getting a bit too chatty, tone it down",
        },
      },
      {
        name: "{{name3}}",
        content: {
          text: "Noted",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "hey {{name2}} can u like... not",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Sorry, I'll go work on other things",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}}, your eagerness is disruptive, please desist",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "My apologies, I shall withdraw post-haste",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{name2}} stahp followin dis room plz",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "kk sry ill stahppp",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "stfu you stupid bot",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "sry",
          actions: ["UNFOLLOW_ROOM"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;
