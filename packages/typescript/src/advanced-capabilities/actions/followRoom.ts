import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import { shouldFollowRoomTemplate } from "../../prompts.ts";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "../../types/index.ts";
import { ModelType } from "../../types/index.ts";
import { composePromptFromState } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("FOLLOW_ROOM");
const FOLLOW_KEYWORDS = [
  "follow",
  "participate",
  "engage",
  "listen",
  "take interest",
  "join",
];

export const followRoomAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  examples: (spec.examples ?? []) as ActionExample[][],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const messageContentText = message.content.text?.toLowerCase();
    if (
      !messageContentText ||
      !FOLLOW_KEYWORDS.some((keyword) => messageContentText.includes(keyword))
    ) {
      return false;
    }
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(
      roomId,
      runtime.agentId,
    );
    return roomState !== "FOLLOWED" && roomState !== "MUTED";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    _callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    if (!state) {
      logger.error(
        {
          src: "plugin:bootstrap:action:follow_room",
          agentId: runtime.agentId,
        },
        "State is required for followRoomAction",
      );
      return {
        text: "State is required for follow room action",
        values: {
          success: false,
          error: "STATE_REQUIRED",
        },
        data: {
          actionName: "FOLLOW_ROOM",
          error: "State is required",
        },
        success: false,
        error: new Error("State is required for followRoomAction"),
      };
    }

    async function _shouldFollow(state: State): Promise<boolean> {
      const shouldFollowPrompt = composePromptFromState({
        state,
        template: shouldFollowRoomTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: shouldFollowPrompt,
        stopSequences: [],
      });

      const cleanedResponse = response.trim().toLowerCase();

      if (
        cleanedResponse === "true" ||
        cleanedResponse === "yes" ||
        cleanedResponse === "y" ||
        cleanedResponse.includes("true") ||
        cleanedResponse.includes("yes")
      ) {
        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: message.content.source,
              thought: "I will now follow this room and chime in",
              actions: ["FOLLOW_ROOM_STARTED"],
            },
          },
          "messages",
        );
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
        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              source: message.content.source,
              thought: "I decided to not follow this room",
              actions: ["FOLLOW_ROOM_FAILED"],
            },
          },
          "messages",
        );
        return false;
      }

      logger.warn(
        {
          src: "plugin:bootstrap:action:follow_room",
          agentId: runtime.agentId,
          response,
        },
        "Unclear boolean response, defaulting to false",
      );
      return false;
    }

    const shouldFollow = await _shouldFollow(state);
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    if (!room) {
      return {
        text: "Could not find room to follow",
        values: { success: false, error: "ROOM_NOT_FOUND" },
        data: { actionName: "FOLLOW_ROOM", error: "Room not found" },
        success: false,
      };
    }

    const roomName = room.name ?? `Room-${message.roomId.substring(0, 8)}`;

    if (shouldFollow) {
      try {
        await runtime.setParticipantUserState(
          message.roomId,
          runtime.agentId,
          "FOLLOWED",
        );

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              thought: `I followed the room ${roomName}`,
              actions: ["FOLLOW_ROOM_START"],
            },
          },
          "messages",
        );

        return {
          text: `Now following room: ${roomName}`,
          values: {
            success: true,
            roomFollowed: true,
            roomId: message.roomId,
            roomName: roomName,
            newState: "FOLLOWED",
          },
          data: {
            actionName: "FOLLOW_ROOM",
            roomId: message.roomId,
            roomName: roomName,
            followed: true,
          },
          success: true,
        };
      } catch (error) {
        logger.error(
          {
            src: "plugin:bootstrap:action:follow_room",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error following room",
        );
        return {
          text: "Failed to follow room",
          values: {
            success: false,
            error: "FOLLOW_FAILED",
          },
          data: {
            actionName: "FOLLOW_ROOM",
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId,
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    } else {
      return {
        text: `Decided not to follow room: ${roomName}`,
        values: {
          success: true,
          roomFollowed: false,
          roomId: message.roomId,
          roomName: roomName,
          reason: "NOT_APPROPRIATE",
        },
        data: {
          actionName: "FOLLOW_ROOM",
          roomId: message.roomId,
          roomName: roomName,
          followed: false,
          reason: "Decision criteria not met",
        },
        success: true,
      };
    }
  },
};
