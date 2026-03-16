/**
 * Send reaction action for Matrix plugin.
 */

import type { Action, ActionResult, HandlerCallback, HandlerOptions, IAgentRuntime, Memory, State } from "@elizaos/core";
import { composePromptFromState, ModelType, parseJSONObjectFromText } from "@elizaos/core";
import { MatrixService } from "../service.js";
import { MATRIX_SERVICE_NAME } from "../types.js";

const SEND_REACTION_TEMPLATE = `You are helping to extract reaction parameters for Matrix.

The user wants to react to a Matrix message with an emoji.

Recent conversation:
{{recentMessages}}

Extract the following:
1. emoji: The emoji to react with (single emoji character)
2. eventId: The event ID of the message to react to (starts with $)

Respond with a JSON object like:
{
  "emoji": "👍",
  "eventId": "$event123"
}

Only respond with the JSON object, no other text.`;

export const sendReaction: Action = {
  name: "MATRIX_SEND_REACTION",
  similes: [
    "REACT_MATRIX",
    "MATRIX_REACT",
    "ADD_MATRIX_REACTION",
  ],
  description: "React to a Matrix message with an emoji",

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
      template: SEND_REACTION_TEMPLATE,
      state: composedState,
    });

    // Extract parameters using LLM
    let reactionInfo: { emoji: string; eventId: string } | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const parsed = parseJSONObjectFromText(response as string);
      if (parsed?.emoji && parsed?.eventId) {
        reactionInfo = {
          emoji: String(parsed.emoji),
          eventId: String(parsed.eventId),
        };
        break;
      }
    }

    if (!reactionInfo) {
      if (callback) {
        await callback({
          text: "I couldn't understand the reaction request. Please specify the emoji and message.",
          source: "matrix",
        });
      }
      return { success: false, error: "Could not extract reaction parameters" };
    }

    // Get room from state
    const roomData = state?.data?.room as Record<string, string> | undefined;
    const roomId = roomData?.roomId;
    if (!roomId) {
      if (callback) {
        await callback({
          text: "I couldn't determine which room this is in.",
          source: "matrix",
        });
      }
      return { success: false, error: "Could not determine room" };
    }

    // Send reaction
    const result = await matrixService.sendReaction(
      roomId,
      reactionInfo.eventId,
      reactionInfo.emoji
    );

    if (!result.success) {
      if (callback) {
        await callback({
          text: `Failed to add reaction: ${result.error}`,
          source: "matrix",
        });
      }
      return { success: false, error: result.error };
    }

    if (callback) {
      await callback({
        text: `Added ${reactionInfo.emoji} reaction.`,
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        emoji: reactionInfo.emoji,
        eventId: reactionInfo.eventId,
        roomId,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "React to the last message with a thumbs up" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll add a thumbs up reaction.",
          actions: ["MATRIX_SEND_REACTION"],
        },
      },
    ],
  ],
};
