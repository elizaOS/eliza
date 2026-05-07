/**
 * Join room action for Matrix plugin.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { composePromptFromState, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import type { MatrixService } from "../service.js";
import { isValidMatrixRoomAlias, isValidMatrixRoomId, MATRIX_SERVICE_NAME } from "../types.js";

const MAX_MATRIX_ROOM_REF_CHARS = 255;
const MATRIX_JOIN_ACTION_TIMEOUT_MS = 30_000;

const JOIN_ROOM_TEMPLATE = `You are helping to extract a Matrix room identifier.

The user wants to join a Matrix room.

Recent conversation:
{{recentMessages}}

Extract the room ID (!room:server) or room alias (#alias:server) to join.

Respond with JSON only, with no prose or fences:
{
  "room": "!room:matrix.org"
}

or:
{
  "room": "#alias:matrix.org"
}`;

export const joinRoom: Action = {
  name: "MATRIX_JOIN_ROOM",
  similes: ["JOIN_MATRIX_ROOM", "ENTER_ROOM"],
  description: "Join a Matrix room by ID or alias",
  descriptionCompressed: "Join Matrix room by id or alias.",
  contexts: ["messaging", "connectors"],
  contextGate: { anyOf: ["messaging", "connectors"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "room",
      description: "Matrix room id (!room:server) or alias (#alias:server).",
      required: false,
      schema: { type: "string" },
    },
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "matrix";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    const matrixService = runtime.getService(MATRIX_SERVICE_NAME) as MatrixService | undefined;

    if (!matrixService?.isConnected()) {
      if (callback) {
        await callback({
          text: "Matrix service is not available.",
          source: "matrix",
        });
      }
      return { success: false, error: "Matrix service not available" };
    }

    // Compose prompt - ensure state has required properties
    const composedState: State = state ?? {
      values: {},
      data: {},
      text: "",
    };
    const prompt = await composePromptFromState({
      template: JOIN_ROOM_TEMPLATE,
      state: composedState,
    });

    // Extract room using LLM
    let room: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(String(response)) as Record<string, unknown> | null;
      if (parsed?.room) {
        const roomStr = String(parsed.room).trim().slice(0, MAX_MATRIX_ROOM_REF_CHARS);
        if (isValidMatrixRoomId(roomStr) || isValidMatrixRoomAlias(roomStr)) {
          room = roomStr;
          break;
        }
      }
    }

    if (!room) {
      if (callback) {
        await callback({
          text: "I couldn't understand which room you want me to join. Please specify a room ID (!room:server) or alias (#alias:server).",
          source: "matrix",
        });
      }
      return { success: false, error: "Could not extract room identifier" };
    }

    // Join room
    try {
      const timeoutMs = MATRIX_JOIN_ACTION_TIMEOUT_MS;
      const roomId = await matrixService.joinRoom(room);

      if (callback) {
        await callback({
          text: `Joined room ${room}.`,
          source: message.content.source as string,
        });
      }

      return {
        success: true,
        data: {
          roomId,
          joined: room,
          timeoutMs,
        },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (callback) {
        await callback({
          text: `Failed to join room: ${error}`,
          source: "matrix",
        });
      }
      return { success: false, error };
    }
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Join #general:matrix.org" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll join that room.",
          actions: ["MATRIX_JOIN_ROOM"],
        },
      },
    ],
  ],
};
