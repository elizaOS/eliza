import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import { shouldMuteRoomTemplate } from "../../prompts.ts";
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
const spec = requireActionSpec("MUTE_ROOM");

export const muteRoomAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  description: spec.description,
  examples: (spec.examples ?? []) as ActionExample[][],
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    const roomId = message.roomId;
    const roomState = await runtime.getParticipantUserState(
      roomId,
      runtime.agentId,
    );
    return roomState !== "MUTED";
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
        { src: "plugin:bootstrap:action:mute_room", agentId: runtime.agentId },
        "State is required for muting a room",
      );
      return {
        text: "State is required for mute room action",
        values: {
          success: false,
          error: "STATE_REQUIRED",
        },
        data: {
          actionName: "MUTE_ROOM",
          error: "State is required",
        },
        success: false,
        error: new Error("State is required for muting a room"),
      };
    }

    async function _shouldMute(state: State): Promise<boolean> {
      const shouldMutePrompt = composePromptFromState({
        state,
        template: shouldMuteRoomTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: shouldMutePrompt,
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
              thought: "I will now mute this room",
              actions: ["MUTE_ROOM_STARTED"],
            },
          },
          "messages",
        );
        return true;
      }

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
              thought: "I decided to not mute this room",
              actions: ["MUTE_ROOM_FAILED"],
            },
          },
          "messages",
        );
      }

      logger.warn(
        {
          src: "plugin:bootstrap:action:mute_room",
          agentId: runtime.agentId,
          response,
        },
        "Unclear boolean response, defaulting to false",
      );
      return false;
    }

    const shouldMute = await _shouldMute(state);
    const room = state.data.room ?? (await runtime.getRoom(message.roomId));

    if (!room) {
      return {
        text: "Could not find room to mute",
        values: { success: false, error: "ROOM_NOT_FOUND" },
        data: { actionName: "MUTE_ROOM", error: "Room not found" },
        success: false,
      };
    }

    const roomName = room.name ?? `Room-${message.roomId.substring(0, 8)}`;

    if (shouldMute) {
      try {
        await runtime.setParticipantUserState(
          message.roomId,
          runtime.agentId,
          "MUTED",
        );

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              thought: `I muted the room ${roomName}`,
              actions: ["MUTE_ROOM_START"],
            },
          },
          "messages",
        );

        return {
          text: `Room muted: ${roomName}`,
          values: {
            success: true,
            roomMuted: true,
            roomId: message.roomId,
            roomName: roomName,
            newState: "MUTED",
          },
          data: {
            actionName: "MUTE_ROOM",
            roomId: message.roomId,
            roomName: roomName,
            muted: true,
          },
          success: true,
        };
      } catch (error) {
        logger.error(
          {
            src: "plugin:bootstrap:action:mute_room",
            agentId: runtime.agentId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Error muting room",
        );
        return {
          text: "Failed to mute room",
          values: {
            success: false,
            error: "MUTE_FAILED",
          },
          data: {
            actionName: "MUTE_ROOM",
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId,
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    } else {
      return {
        text: `Decided not to mute room: ${roomName}`,
        values: {
          success: true,
          roomMuted: false,
          roomId: message.roomId,
          roomName: roomName,
          reason: "NOT_APPROPRIATE",
        },
        data: {
          actionName: "MUTE_ROOM",
          roomId: message.roomId,
          roomName: roomName,
          muted: false,
          reason: "Decision criteria not met",
        },
        success: true,
      };
    }
  },
};
