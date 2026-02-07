/**
 * Send message action for Matrix plugin.
 */

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { composePromptFromState, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import { MatrixService } from "../service.js";
import { MATRIX_SERVICE_NAME, isValidMatrixRoomId, isValidMatrixRoomAlias } from "../types.js";

const SEND_MESSAGE_TEMPLATE = `You are helping to extract send message parameters for Matrix.

The user wants to send a message to a Matrix room.

Recent conversation:
{{recentMessages}}

Extract the following:
1. text: The message text to send
2. roomId: The room ID (!room:server) or alias (#alias:server), or "current" for the current room

Respond with a JSON object like:
{
  "text": "The message to send",
  "roomId": "current"
}

Only respond with the JSON object, no other text.`;

interface SendMessageParams {
  text: string;
  roomId: string;
}

export const sendMessage: Action = {
  name: "MATRIX_SEND_MESSAGE",
  similes: [
    "SEND_MATRIX_MESSAGE",
    "MESSAGE_MATRIX",
    "MATRIX_TEXT",
  ],
  description: "Send a message to a Matrix room",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State
  ): Promise<boolean> => {
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

    if (!matrixService || !matrixService.isConnected()) {
      if (callback) {
        await callback({ text: "Matrix service is not available.", source: "matrix" });
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
      template: SEND_MESSAGE_TEMPLATE,
      state: composedState,
    });

    // Extract parameters using LLM
    let messageInfo: SendMessageParams | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response as string);
      if (parsed?.text) {
        messageInfo = {
          text: String(parsed.text),
          roomId: String(parsed.roomId || "current"),
        };
        break;
      }
    }

    if (!messageInfo || !messageInfo.text) {
      if (callback) {
        await callback({
          text: "I couldn't understand what message you want me to send. Please try again.",
          source: "matrix",
        });
      }
      return { success: false, error: "Could not extract message parameters" };
    }

    // Determine target room
    let targetRoomId: string | undefined;
    if (messageInfo.roomId && messageInfo.roomId !== "current") {
      if (isValidMatrixRoomId(messageInfo.roomId) || isValidMatrixRoomAlias(messageInfo.roomId)) {
        targetRoomId = messageInfo.roomId;
      }
    }

    // Get room from state context if available
    const roomData = state?.data?.room as Record<string, string> | undefined;
    if (!targetRoomId && roomData?.roomId) {
      targetRoomId = roomData.roomId;
    }

    if (!targetRoomId) {
      if (callback) {
        await callback({
          text: "I couldn't determine which room to send to. Please specify a room.",
          source: "matrix",
        });
      }
      return { success: false, error: "Could not determine target room" };
    }

    // Send message
    const result = await matrixService.sendMessage(messageInfo.text, {
      roomId: targetRoomId,
    });

    if (!result.success) {
      if (callback) {
        await callback({
          text: `Failed to send message: ${result.error}`,
          source: "matrix",
        });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      await callback({
        text: "Message sent successfully.",
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        roomId: result.roomId,
        eventId: result.eventId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send a message saying 'Hello everyone!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to the room.",
          actions: ["MATRIX_SEND_MESSAGE"],
        },
      },
    ],
  ],
};
