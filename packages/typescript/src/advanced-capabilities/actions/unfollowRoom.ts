import { requireActionSpec } from "../../generated/spec-helpers.ts";
import { shouldUnfollowRoomTemplate } from "../../prompts.ts";
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
import { composePromptFromState, parseBooleanFromText } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireActionSpec("UNFOLLOW_ROOM");

export const unfollowRoomAction: Action = {
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
    return roomState === "FOLLOWED";
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    _callback?: HandlerCallback,
    _responses?: Memory[],
  ): Promise<ActionResult> => {
    async function _shouldUnfollow(state: State): Promise<boolean> {
      const shouldUnfollowPrompt = composePromptFromState({
        state,
        template: shouldUnfollowRoomTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: shouldUnfollowPrompt,
      });

      const parsedResponse = parseBooleanFromText(response.trim());

      return parsedResponse as boolean;
    }

    if (state && (await _shouldUnfollow(state))) {
      try {
        await runtime.setParticipantUserState(
          message.roomId,
          runtime.agentId,
          null,
        );

        const room = state.data.room ?? (await runtime.getRoom(message.roomId));

        if (!room) {
          return {
            text: "Could not find room to unfollow",
            values: { success: false, error: "ROOM_NOT_FOUND" },
            data: { actionName: "UNFOLLOW_ROOM", error: "Room not found" },
            success: false,
          };
        }

        // Ensure room has a name for consistent return values
        const roomName = room.name ?? `Room-${message.roomId.substring(0, 8)}`;

        await runtime.createMemory(
          {
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            content: {
              thought: `I unfollowed the room ${roomName}`,
              actions: ["UNFOLLOW_ROOM_START"],
            },
          },
          "messages",
        );

        return {
          text: `Stopped following room: ${roomName}`,
          values: {
            success: true,
            roomUnfollowed: true,
            roomId: message.roomId,
            roomName: roomName,
            newState: "NONE",
          },
          data: {
            actionName: "UNFOLLOW_ROOM",
            roomId: message.roomId,
            roomName: roomName,
            unfollowed: true,
          },
          success: true,
        };
      } catch (error) {
        return {
          text: "Failed to unfollow room",
          values: {
            success: false,
            error: "UNFOLLOW_FAILED",
          },
          data: {
            actionName: "UNFOLLOW_ROOM",
            error: error instanceof Error ? error.message : String(error),
            roomId: message.roomId,
          },
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    } else {
      // Decided not to unfollow or missing state
      if (!state) {
        return {
          text: "State is required for unfollow room action",
          values: {
            success: false,
            error: "STATE_REQUIRED",
          },
          data: {
            actionName: "UNFOLLOW_ROOM",
            error: "State is required",
          },
          success: false,
          error: new Error("State is required for unfollow room action"),
        };
      }

      // Create memory about the failed attempt
      await runtime.createMemory(
        {
          entityId: message.entityId,
          agentId: message.agentId,
          roomId: message.roomId,
          content: {
            source: message.content.source,
            thought: "I tried to unfollow a room but I'm not in a room",
            actions: ["UNFOLLOW_ROOM_FAILED"],
          },
        },
        "messages",
      );

      return {
        text: "Did not unfollow room - criteria not met",
        values: {
          success: true,
          roomUnfollowed: false,
          roomId: message.roomId,
          reason: "CRITERIA_NOT_MET",
        },
        data: {
          actionName: "UNFOLLOW_ROOM",
          roomId: message.roomId,
          unfollowed: false,
          reason: "Decision criteria not met",
        },
        success: true,
      };
    }
  },
};
